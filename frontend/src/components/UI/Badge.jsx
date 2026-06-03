export default function Badge({ children, variant = 'muted' }) {
  return (
    <span className={`badge badge-${variant}`}>
      {children}
    </span>
  );
}