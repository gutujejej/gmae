type IconProps = { size?: number; filled?: boolean };

function Svg({ size = 26, fill = 'none', children }: { size?: number; fill?: string; children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const HeartIcon = ({ size, filled }: IconProps) => (
  <Svg size={size} fill={filled ? 'currentColor' : 'none'}>
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.7 1-1.1a5.5 5.5 0 0 0 0-7.8z" />
  </Svg>
);
export const CommentIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z" />
  </Svg>
);
export const BookmarkIcon = ({ size, filled }: IconProps) => (
  <Svg size={size} fill={filled ? 'currentColor' : 'none'}>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </Svg>
);
export const LinkIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </Svg>
);
export const HomeIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <path d="M9 22V12h6v10" />
  </Svg>
);
export const PlusIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const UserIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Svg>
);
export const VolumeIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M11 5L6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
  </Svg>
);
export const VolumeOffIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M11 5L6 9H2v6h4l5 4V5z" />
    <path d="M23 9l-6 6M17 9l6 6" />
  </Svg>
);
export const PlayIcon = ({ size }: IconProps) => (
  <Svg size={size} fill="currentColor">
    <path d="M6 3l14 9-14 9V3z" />
  </Svg>
);
export const CloseIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
);
