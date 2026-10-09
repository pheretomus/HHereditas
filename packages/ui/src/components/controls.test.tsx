import '../test/setup';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Banner } from './Banner';
import { Button } from './Button';
import { Checkbox } from './Checkbox';
import { Disclosure } from './Disclosure';
import { EmptyState } from './EmptyState';
import { Field } from './Field';
import { IconButton } from './IconButton';
import { Kbd } from './Kbd';
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from './Menu';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { PropertyList } from './PropertyList';
import { SearchField } from './SearchField';
import { SegmentedControl } from './SegmentedControl';
import { Switch } from './Switch';
import { TextField } from './TextField';
import { Toolbar, ToolbarGroup, ToolbarSpacer, ToolbarTitle } from './Toolbar';
import { Tooltip } from './Tooltip';

describe('Button', () => {
  it('defaults to type=button and shows a spinner while loading', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} loading>
        Save
      </Button>,
    );
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('icon buttons require a name and toggle aria-pressed', () => {
    render(<IconButton icon={<svg />} aria-label="Show Inspector" pressed tooltip={false} />);
    expect(screen.getByRole('button', { name: 'Show Inspector' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('SegmentedControl', () => {
  function Harness({ onChange }: { onChange: (v: string) => void }) {
    const [value, setValue] = useState('map');
    return (
      <SegmentedControl
        aria-label="View"
        value={value}
        onValueChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        options={[
          { value: 'map', label: 'Map' },
          { value: 'sequence', label: 'Sequence' },
          { value: 'split', label: 'Split', disabled: true },
        ]}
      />
    );
  }

  it('is a radio group with one checked segment', () => {
    render(<Harness onChange={() => undefined} />);
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Map' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Sequence' }).getAttribute('aria-checked')).toBe('false');
  });

  it('changes value on click and with the arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('radio', { name: 'Sequence' }));
    expect(onChange).toHaveBeenLastCalledWith('sequence');
    // A quick tap (key released before the next tick) must select too, not just move focus.
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('map');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Map' }));
    // Wraps around and skips the disabled segment.
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('sequence');
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('map');
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('sequence');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Sequence' }));
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('map');
  });
});

describe('SearchField', () => {
  it('clears with Escape and the clear button, submits with Return / Shift+Return', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClear = vi.fn();
    render(<SearchField aria-label="Find" onSubmit={onSubmit} onClear={onClear} />);
    const input = screen.getByRole('searchbox', { name: 'Find' }) as HTMLInputElement;
    await user.type(input, 'GAATTC');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenLastCalledWith('GAATTC', 'next');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).toHaveBeenLastCalledWith('GAATTC', 'previous');
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(input.value).toBe('');
    expect(onClear).toHaveBeenCalledTimes(1);
    await user.type(input, 'lac');
    await user.keyboard('{Escape}');
    expect(input.value).toBe('');
  });

  it('shows a status such as "3 of 12"', () => {
    render(<SearchField aria-label="Find" value="lacZ" onValueChange={() => undefined} status="3 of 12" />);
    expect(screen.getByText('3 of 12')).toBeTruthy();
  });
});

describe('Switch and Checkbox', () => {
  it('apply className and style to the labelled row, not the control', () => {
    render(
      <>
        <Switch label="Circular" className="row" style={{ width: '100%' }} />
        <Checkbox label="Show ORFs" className="row2" style={{ marginTop: 3 }} />
      </>,
    );
    const sw = screen.getByRole('switch', { name: 'Circular' });
    expect(sw.style.width).toBe('');
    const row = sw.closest('label')!;
    expect(row.className).toContain('row');
    expect(row.style.width).toBe('100%');
    const box = screen.getByRole('checkbox', { name: 'Show ORFs' });
    expect(box.closest('label')!.style.marginTop).toBe('3px');
  });

  it('toggle when their label is clicked', async () => {
    const user = userEvent.setup();
    const onChecked = vi.fn();
    render(<Checkbox label="Translate CDS" onCheckedChange={onChecked} />);
    await user.click(screen.getByText('Translate CDS'));
    expect(onChecked).toHaveBeenLastCalledWith(true);
  });
});

describe('Field', () => {
  it('labels the control and describes it with the hint or error', () => {
    const { rerender } = render(
      <Field label="Name" hint="Shown in the title bar.">
        <TextField />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(document.getElementById(input.getAttribute('aria-describedby')!)!.textContent).toBe('Shown in the title bar.');
    rerender(
      <Field label="Name" error="Required.">
        <TextField />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Name' }).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('Kbd', () => {
  it('renders one key cap per key with a readable label', () => {
    render(<Kbd shortcut="Mod+Shift+F" platform="mac" />);
    const kbd = screen.getByLabelText('⇧⌘F');
    expect(kbd.querySelectorAll('span')).toHaveLength(3);
  });
});

describe('Tooltip', () => {
  it('shows the text and the formatted shortcut', () => {
    document.documentElement.classList.add('hh-platform-mac');
    render(
      <Tooltip content="Hide Inspector" shortcut="Mod+Alt+I" open>
        <button type="button">i</button>
      </Tooltip>,
    );
    expect(screen.getAllByText('Hide Inspector').length).toBeGreaterThan(0);
    expect(screen.getAllByText('⌥⌘I').length).toBeGreaterThan(0);
  });

  it('renders just the trigger without content', () => {
    render(
      <Tooltip content="">
        <button type="button">plain</button>
      </Tooltip>,
    );
    expect(screen.getByRole('button', { name: 'plain' })).toBeTruthy();
  });
});

describe('PropertyList', () => {
  it('shows label/value rows and copies values', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <PropertyList
        items={[
          { label: 'Range', value: '396..1,256', copyValue: '396..1256' },
          { label: 'Length', value: '861 bp' },
          { label: 'Translation', value: 'MSIQHFRV', mono: true, maxLines: 3 },
        ]}
      />,
    );
    expect(screen.getByText('Range').tagName).toBe('DT');
    expect(screen.getByText('396..1,256').closest('dd')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy Range' }));
    });
    expect(writeText).toHaveBeenCalledWith('396..1256');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    expect((screen.getByText('MSIQHFRV') as HTMLElement).style.webkitLineClamp).toBe('3');
  });
});

describe('Popover', () => {
  it('focuses the first text field, not the first button', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Rename</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Rename">
          <Button>Help</Button>
          <TextField aria-label="New name" defaultValue="pUC19" />
        </PopoverContent>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New name' }));
  });

  it('focuses the panel itself when it has no text field', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Info</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Info panel">
          <Button>Edit…</Button>
        </PopoverContent>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Info' }));
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Info panel' }));
  });
});

describe('Menu', () => {
  it('opens from the keyboard and picks radio items', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    const onDigest = vi.fn();
    render(
      <Menu>
        <MenuTrigger asChild>
          <Button>Enzymes</Button>
        </MenuTrigger>
        <MenuContent>
          <MenuRadioGroup value="unique" onValueChange={onValue}>
            <MenuRadioItem value="unique">Unique cutters</MenuRadioItem>
            <MenuRadioItem value="none">None</MenuRadioItem>
          </MenuRadioGroup>
          <MenuItem shortcut="Mod+D" onSelect={onDigest}>
            Digest…
          </MenuItem>
        </MenuContent>
      </Menu>,
    );
    screen.getByRole('button', { name: 'Enzymes' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitemradio', { name: 'Unique cutters' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('menuitemradio', { name: 'None' }));
    expect(onValue).toHaveBeenLastCalledWith('none');
  });
});

/**
 * Tauri 2.12's drag-region rule (tauri/src/window/scripts/drag.js): walk up from the click
 * target; a clickable element without the attribute blocks the drag; "deep" makes the whole
 * subtree draggable; a bare attribute only counts when it is on the clicked element itself.
 */
function tauriWouldDrag(target: Element): boolean {
  const clickable = (el: Element) =>
    ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY'].includes(el.tagName) ||
    (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') ||
    ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'].includes(el.getAttribute('role') ?? '');
  for (let el: Element | null = target; el; el = el.parentElement) {
    const attr = el.getAttribute('data-tauri-drag-region');
    if (clickable(el) && attr === null) return false;
    if (attr === null) continue;
    if (attr === 'false') return false;
    if (attr === 'deep') return true;
    return el === target;
  }
  return false;
}

describe('Toolbar', () => {
  it('marks the bar and its passive parts as window drag regions', () => {
    const { container } = render(
      <Toolbar aria-label="Document">
        <ToolbarTitle title="pFA6a-kanMX6" subtitle="3,938 bp · circular" accessory={<span>Edited</span>} />
        <ToolbarSpacer />
        <ToolbarGroup label="Tools">
          <button type="button">
            <svg data-testid="icon" />x
          </button>
        </ToolbarGroup>
      </Toolbar>,
    );
    const bar = screen.getByRole('toolbar', { name: 'Document' });
    expect(bar.getAttribute('data-tauri-drag-region')).toBe('deep');
    // passive parts are drag regions themselves too (older Tauri versions only look at the target)
    expect(container.querySelectorAll('[data-tauri-drag-region]').length).toBeGreaterThanOrEqual(6);
    expect(screen.getByRole('button', { name: 'x' }).hasAttribute('data-tauri-drag-region')).toBe(false);
    // what Tauri does with a mouse-down on each part
    expect(tauriWouldDrag(bar)).toBe(true);
    expect(tauriWouldDrag(screen.getByText('pFA6a-kanMX6'))).toBe(true);
    expect(tauriWouldDrag(screen.getByText('3,938 bp · circular'))).toBe(true);
    expect(tauriWouldDrag(screen.getByText('Edited'))).toBe(true);
    expect(tauriWouldDrag(screen.getByRole('group', { name: 'Tools' }))).toBe(true);
    expect(tauriWouldDrag(screen.getByRole('button', { name: 'x' }))).toBe(false);
    expect(tauriWouldDrag(screen.getByTestId('icon'))).toBe(false);
  });

  it('never drags from inside fields and segmented controls', () => {
    render(
      <Toolbar aria-label="Document">
        <SegmentedControl
          aria-label="View"
          value="map"
          onValueChange={() => undefined}
          options={[
            { value: 'map', label: 'Map' },
            { value: 'sequence', label: 'Sequence' },
          ]}
        />
        <SearchField aria-label="Search" status="3 of 12" defaultValue="GAATTC" />
      </Toolbar>,
    );
    const group = screen.getByRole('radiogroup', { name: 'View' });
    expect(tauriWouldDrag(group)).toBe(false); // the padding between segments
    const input = screen.getByRole('searchbox', { name: 'Search' });
    expect(tauriWouldDrag(input.parentElement!)).toBe(false); // the field frame
    expect(tauriWouldDrag(screen.getByText('3 of 12'))).toBe(false);
  });
});

describe('Disclosure, Banner, EmptyState', () => {
  it('Disclosure toggles its content', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure title="Analysis" defaultOpen={false}>
        <p>Composition</p>
      </Disclosure>,
    );
    const trigger = screen.getByRole('button', { name: 'Analysis' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Composition')).toBeTruthy();
  });

  it('Banner uses alert semantics for problems and can be dismissed', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Banner tone="warning" title="Dam methylation" onDismiss={onDismiss}>
        XbaI may be blocked.
      </Banner>,
    );
    expect(screen.getByRole('alert').textContent).toContain('XbaI may be blocked.');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('EmptyState shows title, message and actions', () => {
    render(<EmptyState title="No Selection" message="Select bases." actions={<Button>Add</Button>} />);
    expect(screen.getByText('No Selection')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add' })).toBeTruthy();
  });
});
