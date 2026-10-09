/**
 * @hhereditas/viewer — interactive sequence visualizations.
 * Components are presentational: they receive data + selection as props and report user
 * intent through callbacks; application state lives in the app.
 */
export * from './selection';
export * from './common/colors';
export * from './common/format';
export * from './common/useElementSize';
export * from './circular';
export * from './linear';
export * from './sequence';
export * from './gel';
// The three maps define structurally identical shared types; export one copy explicitly.
export type { FeatureClickInfo, MapShowOptions, MapTarget } from './circular';
