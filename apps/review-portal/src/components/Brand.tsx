/** CrewBrief mark: a slate tile with a hi-vis tick. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#1B2A35" />
      <path d="M8 9.5h16" stroke="#3D5363" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M9.5 18l4.2 4.2L23 13" fill="none" stroke="#F26B1D" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <span className="wordmark">
      <BrandMark size={size} />
      <span className="wordmark-text">CrewBrief</span>
    </span>
  );
}
