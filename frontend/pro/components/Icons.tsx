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

export const SearchIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
);
export const InboxIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 5h16v11H8l-4 4z" />
  </Svg>
);
export const SendIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M22 2L11 13" />
    <path d="M22 2l-7 20-4-9-9-4z" />
  </Svg>
);
export const BackIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M15 18l-6-6 6-6" />
  </Svg>
);
export const EditIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Svg>
);
export const CheckIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
);
export const CheckCheckIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M1.5 12.5L6 17l9-9.5" />
    <path d="M10 15.5l1.5 1.5 9-9.5" />
  </Svg>
);
export const GridIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M5 4v16M10 4v16M15 4v16M20 4v16" />
  </Svg>
);
export const MoreIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" />
  </Svg>
);
export const TrashIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </Svg>
);
export const FlagIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 22V4M4 4h13l-2 4 2 4H4" />
  </Svg>
);
