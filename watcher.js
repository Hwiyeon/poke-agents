'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const EventEmitter = require('events');
const { normalizeLine } = require('./parser');

const DEFAULT_SCAN_INTERVAL_MS = 2500;
const DEFAULT_INITIAL_READ_BYTES = 128 * 1024;

class TranscriptWatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.rootPath = path.resolve(options.rootPath || path.join(os.homedir(), '.claude', 'projects'));
    this.scanIntervalMs = options.scanIntervalMs || DEFAULT_SCAN_INTERVAL_MS;
    this.initialReadBytes = options.initialReadBytes || DEFAULT_INITIAL_READ_BYTES;

    this.fileStates = new Map();
    this.fileWatchers = new Map();
    this.dirWatchers = new Map();
    this.scanTimer = null;
    this.scanQueued = false;
    this.started = false;
  }

  async start() {
    if (this.started) {
      return;
    }
    this.started = true;

    await this.scanTree();
    this.scanTimer = setInterval(() => {
      this.scanTree().catch((error) => this.emit('warn', `scan failed: ${error.message}`));
    }, this.scanIntervalMs);
    this.scanTimer.unref();

    this.emit('info', `watching Claude transcripts under ${this.rootPath}`);
  }

  async stop() {
    if (!this.started) {
      return;
    }
    this.started = false;

    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }

    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    for (const watcher of this.dirWatchers.values()) {
      watcher.close();
    }

    this.fileWatchers.clear();
    this.dirWatchers.clear();
    this.fileStates.clear();
  }

  queueScan(delayMs = 120) {
    if (this.scanQueued || !this.started) {
      return;
    }
    this.scanQueued = true;
    setTimeout(() => {
      this.scanQueued = false;
      this.scanTree().catch((error) => this.emit('warn', `queued scan failed: ${error.message}`));
    }, delayMs).unref();
  }

  async scanTree() {
    let entries;
    try {
      entries = await this.walk(this.rootPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.emit('warn', `path does not exist yet: ${this.rootPath}`);
        return;
      }
      throw error;
    }

    const liveDirs = new Set();
    const liveFiles = new Set();

    for (const item of entries) {
      if (item.type === 'dir') {
        liveDirs.add(item.path);
        this.ensureDirWatcher(item.path);
      } else if (item.type === 'file' && item.path.toLowerCase().endsWith('.jsonl')) {
        liveFiles.add(item.path);
        await this.ensureFileTracked(item.path);
      }
    }

    for (const dirPath of this.dirWatchers.keys()) {
      if (!liveDirs.has(dirPath)) {
        const watcher = this.dirWatchers.get(dirPath);
        if (watcher) {
          watcher.close();
        }
        this.dirWatchers.delete(dirPath);
      }
    }

    for (const filePath of this.fileStates.keys()) {
      if (!liveFiles.has(filePath)) {
        this.fileStates.delete(filePath);
        const watcher = this.fileWatchers.get(filePath);
        if (watcher) {
          watcher.close();
        }
        this.fileWatchers.delete(filePath);
      }
    }
  }

  async walk(startPath) {
    const out = [];
    const stack = [path.resolve(startPath)];

    while (stack.length > 0) {
      const dirPath = stack.pop();
      let dirents;
      try {
        dirents = await fsp.readdir(dirPath, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EACCES') {
          continue;
        }
        throw error;
      }

      out.push({ type: 'dir', path: dirPath });
      for (const dirent of dirents) {
        const absPath = path.join(dirPath, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(absPath);
        } else if (dirent.isFile()) {
          out.push({ type: 'file', path: absPath });
        }
      }
    }

    return out;
  }

  ensureDirWatcher(dirPath) {
    if (this.dirWatchers.has(dirPath)) {
      return;
    }

    try {
      const watcher = fs.watch(dirPath, () => this.queueScan());
      watcher.on('error', (error) => {
        this.emit('warn', `dir watch error (${dirPath}): ${error.message}`);
        this.dirWatchers.delete(dirPath);
      });
      this.dirWatchers.set(dirPath, watcher);
    } catch (error) {
      this.emit('warn', `failed to watch dir ${dirPath}: ${error.message}`);
    }
  }

  async ensureFileTracked(filePath) {
    if (!this.fileStates.has(filePath)) {
      const state = {
        position: 0,
        leftover: '',
        reading: false,
        pending: false
      };
      this.fileStates.set(filePath, state);

      await this.primeFile(filePath, state);
      this.ensureFileWatcher(filePath);
    }

    await this.tailFile(filePath);
  }

  ensureFileWatcher(filePath) {
    if (this.fileWatchers.has(filePath)) {
      return;
    }

    try {
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'rename') {
          this.queueScan();
          return;
        }
        this.tailFile(filePath).catch((error) => {
          this.emit('warn', `tail failed (${filePath}): ${error.message}`);
        });
      });
      watcher.on('error', (error) => {
        this.emit('warn', `file watch error (${filePath}): ${error.message}`);
        this.fileWatchers.delete(filePath);
      });
      this.fileWatchers.set(filePath, watcher);
    } catch (error) {
      this.emit('warn', `failed to watch file ${filePath}: ${error.message}`);
    }
  }

  async primeFile(filePath, state) {
    let stats;
    try {
      stats = await fsp.stat(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.emit('warn', `stat failed (${filePath}): ${error.message}`);
      }
      return;
    }

    const bytesToRead = Math.min(this.initialReadBytes, stats.size);
    state.position = Math.max(0, stats.size - bytesToRead);

    if (bytesToRead === 0) {
      return;
    }

    await this.readNewBytes(filePath, state, true);
  }

  async tailFile(filePath) {
    const state = this.fileStates.get(filePath);
    if (!state) {
      return;
    }

    if (state.reading) {
      state.pending = true;
      return;
    }

    state.reading = true;
    try {
      await this.readNewBytes(filePath, state, false);
    } finally {
      state.reading = false;
      if (state.pending) {
        state.pending = false;
        await this.tailFile(filePath);
      }
    }
  }

  async readNewBytes(filePath, state, isPrime) {
    let stats;
    try {
      stats = await fsp.stat(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.emit('warn', `stat failed (${filePath}): ${error.message}`);
      }
      return;
    }

    if (stats.size < state.position) {
      state.position = 0;
      state.leftover = '';
    }

    if (stats.size === state.position) {
      return;
    }

    const start = state.position;
    const end = stats.size;
    const length = end - start;

    let fd;
    try {
      fd = await fsp.open(filePath, 'r');
      const buffer = Buffer.alloc(length);
      let bytesReadTotal = 0;

      while (bytesReadTotal < length) {
        const { bytesRead } = await fd.read(
          buffer,
          bytesReadTotal,
          length - bytesReadTotal,
          start + bytesReadTotal
        );
        if (bytesRead <= 0) {
          break;
        }
        bytesReadTotal += bytesRead;
      }

      state.position = start + bytesReadTotal;

      const text = state.leftover + buffer.subarray(0, bytesReadTotal).toString('utf8');
      const lines = text.split(/\r?\n/);
      state.leftover = lines.pop() || '';

      const outEvents = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }

        const normalizedEvents = normalizeLine(line, {
          filePath,
          configuredRoot: this.rootPath
        });

        for (const event of normalizedEvents) {
          outEvents.push(event);
          this.emit('event', event);
        }
      }

      if (outEvents.length > 0) {
        this.emit('events', outEvents);
      } else if (!isPrime && lines.length > 0) {
        this.emit('debug', `read ${lines.length} lines with no recognized events from ${filePath}`);
      }
    } catch (error) {
      this.emit('warn', `read failed (${filePath}): ${error.message}`);
    } finally {
      if (fd) {
        await fd.close();
      }
    }
  }
}

module.exports = {
  TranscriptWatcher
};
