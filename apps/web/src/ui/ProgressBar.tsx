import styles from './ProgressBar.module.css';

/** Determinate when `value` is a 0..1 number, indeterminate when null. */
export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      className={styles.track}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
    >
      <div
        className={value === null ? styles.indeterminate : styles.fill}
        style={value === null ? undefined : { transform: `scaleX(${value})` }}
      />
    </div>
  );
}
