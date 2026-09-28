export function Toast({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-rise absolute bottom-[22px] left-1/2 z-20 -translate-x-1/2 rounded-[10px] bg-ink px-[18px] py-3 text-[13px] font-medium text-on-ink shadow-toast"
    >
      {message}
    </div>
  )
}
