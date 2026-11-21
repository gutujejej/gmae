export default function Toast({ text }: { text: string }) {
  return text ? <div className="toast" role="status">{text}</div> : null;
}
