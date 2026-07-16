import { audio } from '../audio/Audio';
import type { Controls } from '../input/Controls';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type GameSettings } from '../game/Settings';
import type { View } from '../render/View';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

/** Owns the settings modal and live preference bindings. Lifecycle-sensitive
 * actions (pause, save import, clear data) remain callbacks in main.ts. */
export function installSettingsController(view: View, controls: Controls, onAutoPause: () => void): GameSettings {
  const settings = loadSettings();
  audio.setMusicVolume(settings.musicVol);
  audio.setSfxVolume(settings.sfxVol);
  view.setQualityMode(settings.quality);
  view.setExtendedZoom(settings.extendedZoom);
  view.setGorePrefs(settings.corpseCap, settings.corpseLife);
  controls.settings = settings;

  let returnTo: 'menu' | 'pause' = 'menu';
  const render = (): void => {
    ($('setMusic') as HTMLInputElement).value = String(Math.round(settings.musicVol * 100));
    ($('setSfx') as HTMLInputElement).value = String(Math.round(settings.sfxVol * 100));
    ($('setPan') as HTMLInputElement).value = String(Math.round(settings.panSpeed * 100));
    ($('setInvZoom') as HTMLInputElement).checked = settings.invertZoom;
    ($('setExtZoom') as HTMLInputElement).checked = settings.extendedZoom;
    ($('setEdgePan') as HTMLInputElement).checked = settings.edgePan;
    ($('setAutoPause') as HTMLInputElement).checked = settings.autoPauseOnBlur;
    ($('setTutorials') as HTMLInputElement).checked = settings.tutorials;
    ($('setQuality') as HTMLSelectElement).value = settings.quality;
    ($('setUnitCap') as HTMLSelectElement).value = String(settings.unitCap);
    ($('setBodyCap') as HTMLSelectElement).value = String(settings.corpseCap);
    ($('setBodyLife') as HTMLSelectElement).value = String(settings.corpseLife);
    $('setMusicVal').textContent = `${Math.round(settings.musicVol * 100)}%`;
    $('setSfxVal').textContent = `${Math.round(settings.sfxVol * 100)}%`;
    $('setPanVal').textContent = `${settings.panSpeed.toFixed(1)}×`;
  };
  const open = (from: 'menu' | 'pause'): void => {
    returnTo = from;
    $(from === 'menu' ? 'menu' : 'pausemenu').style.display = 'none';
    render();
    $('settings').style.display = 'flex';
  };
  const close = (): void => {
    $('settings').style.display = 'none';
    $(returnTo === 'menu' ? 'menu' : 'pausemenu').style.display = 'flex';
  };
  ($('btnSettings') as HTMLButtonElement).onclick = () => open('menu');
  ($('btnPauseSettings') as HTMLButtonElement).onclick = () => open('pause');
  ($('btnSettingsBack') as HTMLButtonElement).onclick = close;

  ($('setMusic') as HTMLInputElement).oninput = e => {
    settings.musicVol = Number((e.target as HTMLInputElement).value) / 100;
    audio.setMusicVolume(settings.musicVol); saveSettings(settings);
    $('setMusicVal').textContent = `${Math.round(settings.musicVol * 100)}%`;
  };
  ($('setSfx') as HTMLInputElement).oninput = e => {
    settings.sfxVol = Number((e.target as HTMLInputElement).value) / 100;
    audio.setSfxVolume(settings.sfxVol); saveSettings(settings);
    $('setSfxVal').textContent = `${Math.round(settings.sfxVol * 100)}%`;
    audio.play('click');
  };
  ($('setPan') as HTMLInputElement).oninput = e => {
    settings.panSpeed = Number((e.target as HTMLInputElement).value) / 100;
    saveSettings(settings);
    $('setPanVal').textContent = `${settings.panSpeed.toFixed(1)}×`;
  };
  ($('setInvZoom') as HTMLInputElement).onchange = e => { settings.invertZoom = (e.target as HTMLInputElement).checked; saveSettings(settings); };
  ($('setUnitCap') as HTMLSelectElement).onchange = e => {
    settings.unitCap = Number((e.target as HTMLSelectElement).value) || DEFAULT_SETTINGS.unitCap;
    saveSettings(settings); // picked up when the next level's Game is built
  };
  ($('setBodyCap') as HTMLSelectElement).onchange = e => {
    settings.corpseCap = Number((e.target as HTMLSelectElement).value) || DEFAULT_SETTINGS.corpseCap;
    view.setGorePrefs(settings.corpseCap, settings.corpseLife); saveSettings(settings);
  };
  ($('setBodyLife') as HTMLSelectElement).onchange = e => {
    settings.corpseLife = Number((e.target as HTMLSelectElement).value) || DEFAULT_SETTINGS.corpseLife;
    view.setGorePrefs(settings.corpseCap, settings.corpseLife); saveSettings(settings);
  };
  ($('setExtZoom') as HTMLInputElement).onchange = e => {
    settings.extendedZoom = (e.target as HTMLInputElement).checked;
    view.setExtendedZoom(settings.extendedZoom); saveSettings(settings);
  };
  ($('setEdgePan') as HTMLInputElement).onchange = e => { settings.edgePan = (e.target as HTMLInputElement).checked; saveSettings(settings); };
  ($('setAutoPause') as HTMLInputElement).onchange = e => { settings.autoPauseOnBlur = (e.target as HTMLInputElement).checked; saveSettings(settings); };
  ($('setTutorials') as HTMLInputElement).onchange = e => { settings.tutorials = (e.target as HTMLInputElement).checked; saveSettings(settings); };
  ($('setQuality') as HTMLSelectElement).onchange = e => {
    settings.quality = (e.target as HTMLSelectElement).value as GameSettings['quality'];
    view.setQualityMode(settings.quality); saveSettings(settings);
  };
  addEventListener('blur', () => { if (settings.autoPauseOnBlur) onAutoPause(); });
  return settings;
}
