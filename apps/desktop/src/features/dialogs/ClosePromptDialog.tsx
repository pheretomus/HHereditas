/** "Do you want to save the changes?" alert for closing a document or the window. */
import { Dialog } from '@hhereditas/ui';
import { resolveClosePrompt } from '../../app/commands';
import { platform } from '../../platform';
import { useApp } from '../../state/store';

export function ClosePromptDialog() {
  const prompt = useApp((s) => s.closePrompt);
  const doc = useApp((s) => (s.closePrompt ? s.documents.find((d) => d.id === s.closePrompt!.docId) : undefined));
  const answer = (a: 'save' | 'discard' | 'cancel') => void resolveClosePrompt(a, platform.closeWindow);
  return (
    <Dialog
      open={!!prompt && !!doc}
      onOpenChange={(o) => {
        if (!o && useApp.getState().closePrompt) answer('cancel');
      }}
      title={`Do you want to save the changes made to “${doc?.record.name ?? ''}”?`}
      message="Your changes will be lost if you don't save them."
      primaryAction={{ label: 'Save…', onAction: () => answer('save') }}
      tertiaryAction={{ label: "Don't Save", onAction: () => answer('discard') }}
      secondaryAction={{ label: 'Cancel', onAction: () => answer('cancel') }}
      width={280}
    />
  );
}
