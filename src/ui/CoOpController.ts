import type { PeerCoOpClient, ConnectionSnapshot } from '../net/PeerCoOpClient';
import type { AcceptedCommand, ExpeditionDifficulty, RoomState, ServerMessage } from '../net/protocol';
import type { UI } from './UI';

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface CoOpControllerPorts {
  showScreen: (screen: 'coopmenu' | 'cooplobby') => void;
  onBack: () => void;
  onConnection: (snapshot: ConnectionSnapshot) => void;
  onAccepted: (accepted: AcceptedCommand) => void;
  onLeave: () => void;
  isInterlude: () => boolean;
}

/** Owns direct-handshake/lobby DOM. Expedition construction and command
 * application remain in main.ts through narrow callbacks. */
export class CoOpController {
  constructor(private coop: PeerCoOpClient, private ui: UI, private ports: CoOpControllerPorts) {}

  install(): void {
    ($('btnCoop') as HTMLButtonElement).onclick = () => this.open();
    ($('btnCoopBack') as HTMLButtonElement).onclick = this.ports.onBack;
    ($('btnCoopHost') as HTMLButtonElement).onclick = () => void this.host();
    ($('btnCoopJoin') as HTMLButtonElement).onclick = () => void this.join();
    ($('btnCoopLobbyBack') as HTMLButtonElement).onclick = this.ports.onLeave;
    ($('btnCoopCopy') as HTMLButtonElement).onclick = () => void this.copyInvite();
    ($('btnCoopCopyResponse') as HTMLButtonElement).onclick = () => void this.copyResponse();
    ($('btnCoopReview') as HTMLButtonElement).onclick = () => void this.review();
    ($('btnCoopAccept') as HTMLButtonElement).onclick = () => void this.accept();
    ($('btnCoopReject') as HTMLButtonElement).onclick = () => void this.withButton('btnCoopReject', 'Rejecting…', async () => {
      this.showError(''); await this.coop.rejectPendingJoin(); this.renderLobby(); this.ui.toast('Join request rejected');
    });
    ($('btnCoopReady') as HTMLButtonElement).onclick = () => {
      const snapshot = this.coop.snapshot();
      const local = snapshot.room?.players.find(player => player.id === snapshot.playerId);
      if (!this.coop.setReady(!local?.ready)) this.ui.toast('Still connecting — try Ready again in a moment', 'err');
    };
    ($('btnMultiplayer') as HTMLButtonElement).onclick = () => {
      const panel = $('multiplayerpanel'); panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    };
    ($('closeMultiplayer') as HTMLButtonElement).onclick = () => { $('multiplayerpanel').style.display = 'none'; };
    ($('btnMpCopy') as HTMLButtonElement).onclick = () => void this.copyInvite('btnMpCopy');
    ($('btnMpReconnect') as HTMLButtonElement).onclick = () => this.coop.reconnectNow();
    ($('btnMpLeave') as HTMLButtonElement).onclick = this.ports.onLeave;
    this.coop.onConnection = snapshot => this.renderConnection(snapshot);
    this.coop.onMessage = message => this.handleMessage(message);
    this.coop.onJoinRequest = request => { this.renderLobby(); this.ui.toast(`${request.playerName} wants to join`); };
    this.renderConnection(this.coop.snapshot());
    window.setInterval(() => { if (this.coop.snapshot().status === 'connected') this.coop.ping(); }, 3000);
  }

  open(): void {
    this.showError('');
    const code = new URL(location.href).searchParams.get('coop');
    if (code) ($('coopInviteCode') as HTMLTextAreaElement).value = code;
    this.ports.showScreen('coopmenu');
  }

  renderLobby(): void {
    const snapshot = this.coop.snapshot(), room = snapshot.room;
    if (!room) return;
    $('coopLobbyMeta').innerHTML = `<b>${escapeHtml(room.settings.roomName)}</b> · direct room ${escapeHtml(room.inviteCode)} · ${escapeHtml(room.settings.difficulty)} · level ${room.level}`;
    $('coopLobbyPlayers').innerHTML = this.playerRows(room, snapshot.playerId, 'coopplayer');
    const local = room.players.find(player => player.id === snapshot.playerId);
    const bothReady = room.players.length === 2 && room.players.every(player => player.ready);
    const status = $('coopLobbyStatus');
    status.textContent = this.ports.isInterlude() ? 'Level cleared — the Expedition marches on shortly…'
      : snapshot.status === 'error' ? snapshot.error ?? 'The direct connection failed.'
      : snapshot.role === 'guest' && snapshot.status !== 'connected' ? 'Share the response code with the host, then wait for them to accept it.'
      : room.players.length < 2 ? this.coop.pendingJoin() ? 'Review this player, then accept or reject the request.' : 'Share your code, then paste the guest response below.'
      : bothReady ? 'Both players ready — the Expedition is starting.' : 'Choose Ready when your connection is stable.';
    status.className = `tag coop-status ${snapshot.status === 'error' ? 'error' : snapshot.status === 'connected' ? 'connected' : 'waiting'}`;
    const ready = $('btnCoopReady') as HTMLButtonElement; ready.textContent = local?.ready ? 'Cancel ready' : 'Ready to start';
    ready.classList.toggle('ghost', !!local?.ready); ready.style.display = snapshot.status === 'connected' ? '' : 'none';
    $('coopHostHandshake').style.display = snapshot.role === 'host' && snapshot.status !== 'connected' ? 'block' : 'none';
    $('coopGuestHandshake').style.display = snapshot.role === 'guest' && snapshot.status !== 'connected' ? 'block' : 'none';
    ($('coopHostCode') as HTMLTextAreaElement).value = this.coop.encryptedInvite();
    ($('coopGeneratedResponse') as HTMLTextAreaElement).value = this.coop.encryptedJoinResponse();
    $('coopGuestSafety').textContent = this.coop.verificationCode(); $('coopHostSafety').textContent = this.coop.verificationCode();
    const pending = this.coop.pendingJoin(); $('coopApproval').style.display = pending ? 'block' : 'none';
    $('coopHostResponseStep').style.display = pending ? 'none' : ''; $('coopPendingName').textContent = pending?.playerName ?? '';
    const connected = snapshot.status === 'connected', shareDone = snapshot.role === 'guest' || !!pending || connected;
    $('coopStepShare').className = shareDone ? 'done' : 'active'; $('coopStepConnect').className = connected ? 'done' : shareDone ? 'active' : '';
    $('coopStepReady').className = connected ? 'active' : '';
    const bars = $('coopProgress').querySelectorAll<HTMLElement>('b'); bars[0]?.classList.toggle('done', shareDone); bars[1]?.classList.toggle('done', connected);
  }

  private async host(): Promise<void> { await this.withButton('btnCoopHost', 'Creating secure code…', async () => {
    this.showError(''); await this.coop.createRoom(($('coopPlayerName') as HTMLInputElement).value, {
      visibility: 'unlisted', roomName: ($('coopRoomName') as HTMLInputElement).value, region: 'Europe',
      difficulty: ($('coopDifficulty') as HTMLSelectElement).value as ExpeditionDifficulty, mode: 'expedition', passwordProtected: false,
    }); this.renderLobby(); this.ports.showScreen('cooplobby');
  }); }
  private async join(): Promise<void> { await this.withButton('btnCoopJoin', 'Opening host code…', async () => {
    this.showError(''); const code = ($('coopInviteCode') as HTMLTextAreaElement).value;
    if (!code.trim()) throw new Error('Paste the host code before joining');
    await this.coop.joinByInvite(code, ($('coopPlayerName') as HTMLInputElement).value); this.renderLobby(); this.ports.showScreen('cooplobby');
  }); }
  private renderConnection(snapshot: ConnectionSnapshot): void {
    this.ports.onConnection(snapshot); $('coopStatusDot').className = snapshot.status;
    ($('btnMultiplayer') as HTMLButtonElement).style.display = snapshot.room ? 'block' : 'none';
    $('mpConnection').textContent = `${snapshot.status.replace(/([A-Z])/g, ' $1')}${snapshot.rtt === null ? '' : ` · ${Math.round(snapshot.rtt)} ms`}${snapshot.error ? ` · ${snapshot.error}` : ''}`;
    const banner = $('coopConnectionBanner'), troubled = snapshot.room && ['paused', 'error'].includes(snapshot.status);
    banner.style.display = troubled ? 'block' : 'none'; banner.textContent = snapshot.status === 'paused' ? 'Direct peer disconnected — Expedition paused.' : 'Direct connection failed — create a fresh invite to retry.';
    if (!snapshot.room) { $('mpRoom').innerHTML = ''; $('mpPlayers').innerHTML = ''; return; }
    $('mpRoom').innerHTML = `<div class="mp-room"><b>${escapeHtml(snapshot.room.settings.roomName)}</b>Invite ${escapeHtml(snapshot.room.inviteCode)} · level ${snapshot.room.level}</div>`;
    $('mpPlayers').innerHTML = this.playerRows(snapshot.room, snapshot.playerId, 'mp-player'); this.renderLobby();
  }
  private playerRows(room: RoomState, localId: string | null, cls: string): string { return room.players.map(player =>
    `<div class="${cls}"><span class="dot" style="background:${escapeHtml(player.color)}"></span><div><b>${escapeHtml(player.name)}${player.id === localId ? ' (you)' : ''}</b><small>${player.host ? 'Host · ' : ''}${player.ready ? 'Ready' : 'Not ready'}</small></div><span class="mp-presence ${player.presence}">${escapeHtml(player.presence)}</span></div>`).join(''); }
  private handleMessage(message: ServerMessage): void { if (message.type === 'commandAccepted') this.ports.onAccepted(message.accepted); else if (message.type === 'commandRejected') this.ui.toast(`Command rejected: ${message.reason}`, 'err'); }
  private showError(message: string): void { for (const id of ['coopError', 'coopLobbyError']) { const el = document.getElementById(id); if (el) { el.textContent = message; el.style.display = message ? 'block' : 'none'; } } }
  private async copyInvite(id = 'btnCoopCopy'): Promise<void> { const text = this.coop.encryptedInvite(); if (text) await this.copy(text, id, 'Host code copied'); }
  private async copyResponse(): Promise<void> { const text = this.coop.encryptedJoinResponse(); if (text) await this.copy(text, 'btnCoopCopyResponse', 'Response code copied'); }
  private async review(): Promise<void> { await this.withButton('btnCoopReview', 'Checking response…', async () => { this.showError(''); const response = ($('coopJoinResponse') as HTMLTextAreaElement).value; if (!response.trim()) throw new Error("Paste your friend's response code first"); await this.coop.reviewJoinResponse(response); this.renderLobby(); }); }
  private async accept(): Promise<void> { await this.withButton('btnCoopAccept', 'Connecting…', async () => { this.showError(''); await this.coop.acceptPendingJoin(); this.renderLobby(); }); }
  private async copy(text: string, id: string, message: string): Promise<void> { const button = $(id) as HTMLButtonElement, original = button.textContent ?? 'Copy code'; try { await navigator.clipboard.writeText(text); button.textContent = 'Copied ✓'; button.classList.add('copied'); this.ui.toast(message); window.setTimeout(() => { button.textContent = original; button.classList.remove('copied'); }, 1800); } catch { this.ui.toast('Clipboard blocked — select the code and copy it', 'err'); } }
  private async withButton(id: string, busy: string, action: () => Promise<void>): Promise<void> { const button = $(id) as HTMLButtonElement, original = button.textContent ?? ''; button.disabled = true; button.textContent = busy; try { await action(); } catch (error) { this.showError(error instanceof Error ? error.message : String(error)); } finally { button.disabled = false; button.textContent = original; } }
}
