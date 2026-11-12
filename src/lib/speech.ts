// 英文朗读：使用系统自带的语音合成，离线可用。
// iPhone 预装的英语声音是压缩版，听起来比较机械；在「设置 → 辅助功能 → 朗读内容 → 声音 → 英语」
// 里下载「高级」或「增强」音质的声音后，这里会自动优先使用。
import { useSyncExternalStore } from 'react';
import { getSettings } from './settings';

let current: SpeechSynthesisUtterance | null = null; // 保持引用，避免播放中被回收

export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window;

// macOS / iOS 自带的趣味声音和老式合成声音，读书时不合适
const NOVELTY =
  /\b(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Kathy|Ralph|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/i;
const NOVELTY_URI = /speech\.synthesis\.voice|eloquence/i;

/** 音质等级：3 高级、2 增强、1 普通 */
export function voiceQuality(v: SpeechSynthesisVoice): number {
  const s = `${v.voiceURI} ${v.name}`;
  if (/premium|高级|高品質|高品质/i.test(s)) return 3;
  if (/enhanced|增强|增強|优化|優化/i.test(s)) return 2;
  return 1;
}

const isEnglish = (v: SpeechSynthesisVoice) => v.lang.replace('_', '-').toLowerCase().startsWith('en');

/** 可选的英语声音，音质好的、美式的排在前面 */
export function englishVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported) return [];
  const list = speechSynthesis.getVoices().filter((v) => isEnglish(v) && !NOVELTY.test(v.name) && !NOVELTY_URI.test(v.voiceURI));
  const us = (v: SpeechSynthesisVoice) => (v.lang.replace('_', '-') === 'en-US' ? 1 : 0);
  const liked = (v: SpeechSynthesisVoice) => (/Ava|Samantha|Zoe|Evan|Allison|Susan|Nathan|Noelle|Tom|Google US English/i.test(v.name) ? 1 : 0);
  return list.sort((a, b) => voiceQuality(b) - voiceQuality(a) || us(b) - us(a) || liked(b) - liked(a) || a.name.localeCompare(b.name));
}

/** 用户在设置里选的声音；没选或已不存在时自动挑音质最好的 */
function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = englishVoices();
  const chosen = getSettings().voice;
  return (chosen && voices.find((v) => v.voiceURI === chosen)) || voices[0];
}

/** 声音列表是异步加载的，下载新声音后也会变化 */
const voiceListeners = new Set<() => void>();
let voiceVersion = 0;
if (speechSupported) {
  speechSynthesis.getVoices(); // 预热语音列表
  speechSynthesis.addEventListener?.('voiceschanged', () => {
    voiceVersion++;
    voiceListeners.forEach((fn) => fn());
  });
}
export function useVoices(): SpeechSynthesisVoice[] {
  useSyncExternalStore(
    (fn) => {
      voiceListeners.add(fn);
      return () => voiceListeners.delete(fn);
    },
    () => voiceVersion
  );
  return englishVoices();
}

export function speak(text: string, rate: number, onEnd: () => void) {
  if (!speechSupported) return onEnd();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice();
  u.lang = voice?.lang || 'en-US';
  u.rate = rate;
  if (voice) u.voice = voice;
  u.onend = u.onerror = () => {
    if (current === u) {
      current = null;
      onEnd();
    }
  };
  current = u;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  current = null;
  if (speechSupported) speechSynthesis.cancel();
}
