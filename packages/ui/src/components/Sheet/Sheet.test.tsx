import '../../test/setup';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '../Dialog';
import { TextField } from '../TextField';
import { Sheet } from './Sheet';

function SheetHarness({ onCreate, onCancel, disabled }: { onCreate: () => void; onCancel?: () => void; disabled?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="New Sequence"
        description="Create an empty DNA sequence."
        onCancel={onCancel}
        primaryAction={{
          label: 'Create',
          disabled,
          onAction: () => {
            onCreate();
            setOpen(false);
          },
        }}
      >
        <TextField aria-label="Name" defaultValue="Untitled" />
        <textarea aria-label="Notes" />
      </Sheet>
    </>
  );
}

describe('Sheet', () => {
  it('is a labelled modal dialog with primary and cancel buttons', () => {
    render(<SheetHarness onCreate={() => undefined} />);
    const dialog = screen.getByRole('dialog', { name: 'New Sequence' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('Return in a text field triggers the primary action', () => {
    const onCreate = vi.fn();
    render(<SheetHarness onCreate={onCreate} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter' });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state').textContent).toBe('closed');
  });

  it('ignores Return in multi-line fields, during IME composition and when disabled', () => {
    const onCreate = vi.fn();
    const { unmount } = render(<SheetHarness onCreate={onCreate} />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Notes' }), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter', keyCode: 229 });
    expect(onCreate).not.toHaveBeenCalled();
    unmount();
    render(<SheetHarness onCreate={onCreate} disabled />);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter' });
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('Escape and the Cancel button dismiss it', () => {
    const onCancel = vi.fn();
    render(<SheetHarness onCreate={() => undefined} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state').textContent).toBe('closed');
  });

  it('Cancel button calls onCancel and closes', () => {
    const onCancel = vi.fn();
    render(<SheetHarness onCreate={() => undefined} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state').textContent).toBe('closed');
  });
});

function AlertHarness({ onSave, onDiscard, onCancel }: { onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Save changes?"
      message="Your changes will be lost if you don’t save them."
      primaryAction={{ label: 'Save', onAction: onSave }}
      tertiaryAction={{ label: 'Don’t Save', destructive: true, onAction: onDiscard }}
      secondaryAction={{ label: 'Cancel', onAction: onCancel }}
    />
  );
}

describe('Dialog (alert)', () => {
  it('focuses the default button and confirms with Return', () => {
    const onSave = vi.fn();
    render(<AlertHarness onSave={onSave} onDiscard={() => undefined} onCancel={() => undefined} />);
    const dialog = screen.getByRole('alertdialog', { name: 'Save changes?' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
    // Return on a focused button is the button's own job (click); Return elsewhere confirms
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('Escape runs the cancel action', () => {
    const onCancel = vi.fn();
    render(<AlertHarness onSave={() => undefined} onDiscard={() => undefined} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('runs the tertiary action from its button', () => {
    const onDiscard = vi.fn();
    render(<AlertHarness onSave={() => undefined} onDiscard={onDiscard} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Don’t Save' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
