import { ShieldAlert } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useTheaterStore } from '../../stores/theaterStore';
import { Button } from '../ui/Button';

type InsecureRealmMediaModalData = {
  context?: 'voice' | 'theater';
  channelId?: string;
  channelName?: string | null;
};

function getModalData(value: unknown): InsecureRealmMediaModalData {
  if (!value || typeof value !== 'object') return {};
  return value as InsecureRealmMediaModalData;
}

export function InsecureRealmMediaDialog() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);

  if (activeModal !== 'insecureRealmMedia') return null;

  const { context = 'voice', channelId, channelName } = getModalData(modalData);

  const handleJoin = () => {
    closeModal();
    if (!channelId) return;
    if (context === 'theater') {
      void useTheaterStore.getState().joinTheater(channelId, channelName ?? undefined, { acknowledgedInsecureRealm: true });
    } else {
      void useVoiceStore.getState().joinVoice(channelId, { acknowledgedInsecureRealm: true });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-bg-elevated shadow-xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-warning/15 text-warning">
            <ShieldAlert size={20} aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">This Realm isn't secured</h2>
            {channelName && (
              <p className="text-xs text-text-muted">{channelName}</p>
            )}
          </div>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm text-text-secondary">
          <p>
            This Realm is using Central Fallback for LiveKit, but the Realm server is HTTP (not secured).
          </p>
          <p>
            Your {context === 'theater' ? 'audio and video' : 'voice audio'} goes to CatRealm Central over an
            encrypted connection. The Realm's own traffic, including the request that connects you to
            this {context === 'theater' ? 'theater' : 'call'}, is not encrypted. Someone on that network path
            could see it or use it to join as you.
          </p>
        </div>

        <div className="flex flex-wrap justify-end gap-3 rounded-b-lg bg-bg-secondary px-5 py-4">
          <Button variant="secondary" size="sm" onClick={closeModal}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleJoin} disabled={!channelId}>
            Join anyway
          </Button>
        </div>
      </div>
    </div>
  );
}
