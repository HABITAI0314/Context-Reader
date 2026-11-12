import { useEffect, useRef, useState } from 'react';
import type { ThemeSetting } from '../types';
import { Icon, toast } from '../components/ui';
import { pingServer } from '../lib/ai';
import { exportBackup, restoreBackup } from '../lib/backup';
import { FONT_MAX, FONT_MIN, updateSettings, useSettings } from '../lib/settings';
import { speak, useVoices, voiceQuality } from '../lib/speech';

const QUALITY: Record<number, string> = { 3: '（高级）', 2: '（增强）', 1: '' };
import { clearCloud, retrySync, useSyncStatus } from '../lib/sync';

const time = (t: number) => {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === new Date().toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
};

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'sepia', label: '护眼' },
  { value: 'dark', label: '深色' },
];

export function Settings({ onBack }: { onBack(): void }) {
  const s = useSettings();
  const [status, setStatus] = useState('');
  const [usage, setUsage] = useState('');
  const restoreInput = useRef<HTMLInputElement>(null);
  const sync = useSyncStatus();
  const voices = useVoices();
  const [clearing, setClearing] = useState<'' | 'confirm' | 'busy'>('');

  const wipeCloud = async () => {
    if (clearing === '') return setClearing('confirm');
    if (clearing === 'busy') return;
    setClearing('busy');
    try {
      await clearCloud();
      toast('云端数据已清空，本机的书和记录都还在');
    } catch (e) {
      toast(`清空失败：${(e as Error).message}`);
    }
    setClearing('');
  };

  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => {
      if (e.usage != null) setUsage(`${(e.usage / 1024 / 1024).toFixed(1)} MB`);
    });
  }, []);

  const test = async () => {
    setStatus('正在连接…');
    try {
      const r = await pingServer();
      setStatus(r.configured ? '连接成功，口令正确' : '口令正确，但服务端还没有配置模型');
      retrySync();
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  const restore = async (file?: File) => {
    if (!file) return;
    try {
      const r = await restoreBackup(file);
      toast(`已恢复：进度 ${r.progress}、收藏 ${r.favorites}、AI 结果 ${r.ai}`);
    } catch (e) {
      toast((e as Error).message);
    }
    if (restoreInput.current) restoreInput.current.value = '';
  };

  return (
    <div className="page">
      <header className="page-head">
        <button className="icon-btn" onClick={onBack} aria-label="返回书架">
          <Icon name="back" />
        </button>
        <h1>设置</h1>
      </header>

      <main className="page-body settings">
        <section>
          <h2>阅读</h2>
          <label className="field">
            <span>字号 {s.fontSize}</span>
            <input type="range" min={FONT_MIN} max={FONT_MAX} step={1} value={s.fontSize} onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })} />
          </label>
          <div className="field">
            <span>主题</span>
            <div className="segmented">
              {THEMES.map((t) => (
                <button key={t.value} className={s.theme === t.value ? 'on' : ''} onClick={() => updateSettings({ theme: t.value })}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>朗读语速 {s.speechRate.toFixed(2)}×</span>
            <input type="range" min={0.6} max={1.3} step={0.05} value={s.speechRate} onChange={(e) => updateSettings({ speechRate: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>朗读声音</span>
            <select value={s.voice} onChange={(e) => updateSettings({ voice: e.target.value })}>
              <option value="">自动（优先高级音质）{voices[0] ? `：${voices[0].name}` : ''}</option>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name}
                  {/[（(]/.test(v.name) ? '' : QUALITY[voiceQuality(v)]} · {v.lang.replace('_', '-')}
                </option>
              ))}
            </select>
          </label>
          <button
            className="row"
            onClick={() => speak('“Watch out, Jack! The monster’s coming! Race you!” Annie raced alone into the woods.', s.speechRate, () => {})}
          >
            试听
          </button>
          {!voices.some((v) => voiceQuality(v) > 1) && (
            <p className="hint">
              现在只有系统预装的普通音质声音，听起来会比较机械。在 iPhone「设置 → 辅助功能 → 朗读内容 → 声音 → 英语」里，
              选一个声音（推荐 Ava、Zoe 或 Evan）并下载「高级」版本，然后彻底关掉这个 App 再打开，这里就会自动用上。
            </p>
          )}
        </section>

        <section>
          <h2>翻译与 AI 讲解</h2>
          <label className="field">
            <span>访问口令</span>
            <input
              type="password"
              value={s.token}
              placeholder="与服务端 ACCESS_TOKEN 相同"
              autoComplete="off"
              autoCapitalize="off"
              onChange={(e) => updateSettings({ token: e.target.value.trim() })}
            />
          </label>
          <label className="field">
            <span>服务地址（可选）</span>
            <input
              type="url"
              value={s.apiBase}
              placeholder="留空表示与本页面同一地址"
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => updateSettings({ apiBase: e.target.value.trim() })}
            />
          </label>
          <button className="row" onClick={test}>
            测试连接
          </button>
          {status && <p className="hint">{status}</p>}
          <p className="hint">只会发送你选中的文字和它所在的那一段。口令只保存在这台设备上。</p>
        </section>

        <section>
          <h2>云同步</h2>
          <button className="row" disabled={sync.state === 'syncing'} onClick={() => retrySync()}>
            {sync.state === 'syncing' ? sync.message || '正在同步…' : '立即同步'}
          </button>
          <p className="hint">
            {sync.state === 'error' ? `同步失败：${sync.message}。` : sync.state !== 'syncing' && sync.message ? `${sync.message}。` : ''}
            {sync.lastSync ? `上次同步：${time(sync.lastSync)}。` : '还没有同步过。'}
            {sync.pending ? ` 还有 ${sync.pending} 项改动等待上传。` : ''}
          </p>
          <p className="hint">
            书籍、阅读进度、收藏、生词和翻译结果会自动同步到你自己的服务器，在其他设备上填同一个访问口令即可看到。
            其他设备导入的书第一次打开时会自动下载；在任何一台设备上删除书，其他设备也会删除。
          </p>
          <button className="row danger" disabled={clearing === 'busy'} onClick={wipeCloud} onBlur={() => clearing === 'confirm' && setClearing('')}>
            {clearing === 'busy' ? '正在清空…' : clearing === 'confirm' ? '再点一次，确认清空云端全部数据' : '清空云端全部数据'}
          </button>
          <p className="hint">
            删除云端保存的所有书籍文件和学习记录，无法恢复。这台设备上的书和记录不受影响，之后的新改动仍会同步；
            其他设备上还没下载到本机的书将无法打开。
          </p>
        </section>

        <section>
          <h2>学习记录</h2>
          <button className="row" onClick={() => exportBackup().catch((e) => toast(e.message))}>
            导出学习记录
          </button>
          <button className="row" onClick={() => restoreInput.current?.click()}>
            从备份恢复
          </button>
          <input ref={restoreInput} type="file" hidden accept=".json,application/json" onChange={(e) => restore(e.target.files?.[0])} />
          <p className="hint">
            开启云同步后一般不需要手动备份。导出的文件包含阅读进度、收藏和已生成的翻译/讲解，不含书籍文件和访问口令。
            {usage && ` 本机已用存储约 ${usage}。`}
          </p>
        </section>
      </main>
    </div>
  );
}
