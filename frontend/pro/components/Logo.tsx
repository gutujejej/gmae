export default function Logo({ size = 44 }: { size?: number }) {
  return (
    <span className="logo" style={{ fontSize: size }} aria-label="pro">
      pro<i />
    </span>
  );
}
