/**
 * Live preview of a cloning product: name and size, a map thumbnail (circular or linear by
 * topology, features, primers and the given restriction sites), an optional side panel (gel),
 * and the engine's error / warnings.
 */
import type { EnzymeSite, SeqRecord } from '@hhereditas/core';
import { Badge, Banner, EmptyState } from '@hhereditas/ui';
import { CircularMap, LinearMap } from '@hhereditas/viewer';
import { FlaskConical } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { primerSites } from '../../state/analysis';
import { formatBp, withoutPrimerFeatures } from './model/common';
import styles from './CloningSheet.module.css';

export interface ProductPreviewProps {
  product: SeqRecord | null;
  /** Restriction sites to draw on the product (e.g. the cloning enzymes). */
  enzymeSites?: readonly EnzymeSite[];
  /** Shown instead of the map when there is no product and no error (what to do next). */
  emptyMessage?: ReactNode;
  /** Controls in the header (e.g. choosing among several products). */
  headerAccessory?: ReactNode;
  /** Right-hand panel, e.g. a gel thumbnail. */
  aside?: ReactNode;
}

const NO_SITES: readonly EnzymeSite[] = [];

export function ProductPreview({ product, enzymeSites = NO_SITES, emptyMessage, headerAccessory, aside }: ProductPreviewProps) {
  // Sources are hidden like in the document window; source features would cover the map.
  const shown = useMemo(() => {
    if (!product) return null;
    const r = withoutPrimerFeatures(product);
    return { ...r, features: r.features.filter((f) => f.type !== 'source') };
  }, [product]);
  const primers = useMemo(() => (shown ? primerSites(shown).sites : []), [shown]);

  return (
    <div className={styles.card} aria-label="Product preview" role="group">
      <div className={styles.cardHeader}>
        <span className={styles.cardTitle} title={product?.name}>
          {product ? product.name : 'Product'}
        </span>
        {product ? (
          <>
            <span className={styles.cardMeta} data-testid="product-size">
              {formatBp(product.seq.length)}
            </span>
            <Badge size="sm" tone={product.topology === 'circular' ? 'accent' : 'neutral'}>
              {product.topology}
            </Badge>
          </>
        ) : null}
        {headerAccessory}
      </div>
      <div className={styles.cardBody}>
        {shown ? (
          <div className={styles.map}>
            {shown.topology === 'circular' ? (
              <CircularMap record={shown} enzymeSites={enzymeSites} primerSites={primers} selection={null} show={{ orfs: false }} />
            ) : (
              <LinearMap record={shown} enzymeSites={enzymeSites} primerSites={primers} selection={null} show={{ orfs: false }} />
            )}
          </div>
        ) : (
          <div className={styles.empty}>
            <EmptyState size="sm" icon={<FlaskConical />} title="No product yet" message={emptyMessage} />
          </div>
        )}
        {aside ? <div className={styles.aside}>{aside}</div> : null}
      </div>
    </div>
  );
}

/** The engine's error (red) and warnings (orange), compact. */
export function Issues({ error, warnings = [] }: { error?: string | null; warnings?: readonly string[] }) {
  if (!error && warnings.length === 0) return null;
  return (
    <div className={styles.issues} aria-live="polite">
      {error ? (
        <Banner tone="error" title="Cannot make the product">
          {error}
        </Banner>
      ) : null}
      {warnings.length ? (
        <Banner tone="warning" title={warnings.length === 1 ? 'Warning' : `${warnings.length} warnings`}>
          {warnings.length === 1 ? (
            warnings[0]
          ) : (
            <ul className={styles.issueList}>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </Banner>
      ) : null}
    </div>
  );
}
