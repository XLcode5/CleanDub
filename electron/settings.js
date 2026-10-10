/**
 * 设置持久化 —— 字段名沿用 CleanDub.Gui/appsettings.json：
 *   defaultPath / strategy(默认 "Cleanest") / verify(Full|Head|Name|Size, 默认 "Full")
 *   detectLinks / excludeDirs
 * 不存在时以默认值创建；读取时做类型与取值校验，非法值回退默认。
 */
const fs = require('fs');

const DEFAULTS = {
  defaultPath: '',
  strategy: 'Cleanest',
  verify: 'Full',
  detectLinks: true,
  recurse: true,
  excludeDirs: []
};

const VALID_VERIFY = new Set(['Full', 'Head', 'Name', 'Size']);

class Settings {
  constructor(filePath) {
    this.filePath = filePath;
    this.cache = null;
  }

  _sanitize(raw) {
    const s = { ...DEFAULTS };
    if (raw && typeof raw === 'object') {
      if (typeof raw.defaultPath === 'string') s.defaultPath = raw.defaultPath;
      if (typeof raw.strategy === 'string' && raw.strategy) s.strategy = raw.strategy;
      if (VALID_VERIFY.has(raw.verify)) s.verify = raw.verify;
      if (typeof raw.detectLinks === 'boolean') s.detectLinks = raw.detectLinks;
      if (typeof raw.recurse === 'boolean') s.recurse = raw.recurse;
      if (Array.isArray(raw.excludeDirs)) {
        s.excludeDirs = raw.excludeDirs.filter(x => typeof x === 'string' && x.trim());
      }
    }
    return s;
  }

  get() {
    if (this.cache) return { ...this.cache };
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      raw = null; // 不存在或损坏 → 用默认值重建
    }
    this.cache = this._sanitize(raw);
    if (!raw) this._write();
    return { ...this.cache };
  }

  update(patch) {
    const current = this.get();
    const merged = this._sanitize({ ...current, ...(patch || {}) });
    this.cache = merged;
    this._write();
    return { ...merged };
  }

  _write() {
    const tmp = this.filePath + '.tmp';
    // 原子写：先写临时文件再重命名，避免崩溃时设置文件截断
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

module.exports = { Settings, DEFAULTS };
