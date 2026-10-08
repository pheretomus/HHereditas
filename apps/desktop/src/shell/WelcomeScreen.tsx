import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FileDown, FilePlus2, FileText, FolderOpen } from 'lucide-react';
import { cx, formatShortcut, getPlatform } from '@hhereditas/ui';
import appIcon from '../../src-tauri/icons/128x128@2x.png';
import { formatCompactLength, formatDocumentSubtitle } from './format';
import { DocumentGlyph } from './glyphs';
import type { RecentFile, SampleSequence } from './types';
import styles from './WelcomeScreen.module.css';

export interface WelcomeScreenProps {
  appName?: string;
  /** One line under the app name. */
  tagline?: ReactNode;
  /** Shown as "Version 0.1.0". */
  version?: string;
  onOpen?: () => void;
  onNewSequence?: () => void;
  recentFiles?: readonly RecentFile[];
  onOpenRecent?: (file: RecentFile) => void;
  /** Shows a "Clear" button on the Recent list. */
  onClearRecent?: () => void;
  samples?: readonly SampleSequence[];
  onOpenSample?: (sample: SampleSequence) => void;
  /**
   * Files are being dragged over the window. Drive it from Tauri's drag-drop events (which
   * replace DOM drag events in the desktop app); in a browser the screen tracks DOM drags.
   */
  dropActive?: boolean;
  /** Files dropped onto the screen (browser drag and drop). */
  onDropFiles?: (files: File[]) => void;
  className?: string;
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/**
 * The empty window: app mark and name, the two primary actions (Open…, New Sequence…), a
 * drop hint, and a side list of recent files and bundled sample plasmids.
 */
export function WelcomeScreen({
  appName = 'HHereditas',
  tagline = 'Plasmid maps, sequences and cloning, free and offline.',
  version,
  onOpen,
  onNewSequence,
  recentFiles = [],
  onOpenRecent,
  onClearRecent,
  samples = [],
  onOpenSample,
  dropActive,
  onDropFiles,
  className,
}: WelcomeScreenProps) {
  const [domDrag, setDomDrag] = useState(false);
  const depth = useRef(0);
  const showDrop = dropActive ?? domDrag;

  const dragHandlers = onDropFiles
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current++;
          setDomDrag(true);
        },
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDomDrag(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          depth.current = 0;
          setDomDrag(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) onDropFiles(files);
        },
      }
    : {};

  return (
    <div className={cx(styles.welcome, className)} {...dragHandlers}>
      <section className={styles.hero} aria-label={`Welcome to ${appName}`}>
        <div className={styles.dragStrip} data-tauri-drag-region="" />
        <div className={styles.heroInner}>
          <img src={appIcon} alt="" className={styles.mark} width={112} height={112} draggable={false} />
          <h1 className={styles.appName}>{appName}</h1>
          <p className={styles.tagline}>{tagline}</p>
          {version ? <p className={styles.version}>Version {version}</p> : null}
          <div className={styles.actions}>
            <ActionRow
              icon={<FolderOpen />}
              title="Open…"
              detail="GenBank, SnapGene, FASTA or ApE files"
              shortcut="Mod+O"
              onClick={onOpen}
            />
            <ActionRow
              icon={<FilePlus2 />}
              title="New Sequence…"
              detail="Paste or type DNA, or start empty"
              shortcut="Mod+N"
              onClick={onNewSequence}
            />
          </div>
        </div>
        <p className={styles.dropHint}>
          <FileDown aria-hidden />
          Drop files anywhere in this window to open them
        </p>
      </section>

      <aside className={styles.side} aria-label="Recent and sample documents">
        <div className={styles.dragStrip} data-tauri-drag-region="" />
        <div className={styles.sideScroll}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Recent</h2>
            {onClearRecent && recentFiles.length > 0 ? (
              <button type="button" className={styles.clear} onClick={onClearRecent}>
                Clear
              </button>
            ) : null}
          </div>
          {recentFiles.length > 0 ? (
            <ul className={styles.list}>
              {recentFiles.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    className={styles.item}
                    onClick={() => onOpenRecent?.(file)}
                    title={file.location ? `${file.location}/${file.name}` : file.name}
                  >
                    <span className={styles.itemIcon}>
                      {file.topology ? <DocumentGlyph topology={file.topology} /> : <FileText aria-hidden />}
                    </span>
                    <span className={styles.itemText}>
                      <span className={styles.itemTitle}>{file.name}</span>
                      {file.location ? <span className={styles.itemDetail}>{file.location}</span> : null}
                    </span>
                    {file.modified ? <span className={styles.itemMeta}>{file.modified}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.emptyList}>Documents you open will appear here.</p>
          )}

          {samples.length > 0 ? (
            <>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Sample Plasmids</h2>
              </div>
              <ul className={styles.list}>
                {samples.map((sample) => (
                  <li key={sample.id}>
                    <button type="button" className={styles.item} onClick={() => onOpenSample?.(sample)}>
                      <span className={styles.itemIcon}>
                        <DocumentGlyph topology={sample.topology} />
                      </span>
                      <span className={styles.itemText}>
                        <span className={styles.itemTitle}>{sample.name}</span>
                        <span className={styles.itemDetail}>
                          {sample.description ?? formatDocumentSubtitle(sample.length, sample.topology)}
                        </span>
                      </span>
                      <span className={styles.itemMeta}>{formatCompactLength(sample.length)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </aside>

      {showDrop ? (
        <div className={styles.dropOverlay} aria-hidden>
          <div className={styles.dropTarget}>
            <FileDown />
            <span>Drop to open</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ActionRow({
  icon,
  title,
  detail,
  shortcut,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  shortcut: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.action}
      onClick={onClick}
      disabled={!onClick}
      aria-keyshortcuts={shortcut.replace('Mod', getPlatform() === 'mac' ? 'Meta' : 'Control')}
    >
      <span className={styles.actionIcon} aria-hidden>
        {icon}
      </span>
      <span className={styles.actionText}>
        <span className={styles.actionTitle}>{title}</span>
        <span className={styles.actionDetail}>{detail}</span>
      </span>
      <span className={styles.actionShortcut} aria-hidden>
        {formatShortcut(shortcut)}
      </span>
    </button>
  );
}
