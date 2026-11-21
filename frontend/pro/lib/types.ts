// One card of the feed (shape returned by the feed_for_you / feed_following SQL functions).
export type FeedVideo = {
  id: string;
  author_id: string;
  caption: string;
  video_path: string;
  thumb_path: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  series_id: string | null;
  series_part: number | null;
  likes_count: number;
  comments_count: number;
  saves_count: number;
  created_at: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  liked: boolean;
  saved: boolean;
  following: boolean;
  score: number;
};

export type Profile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string;
  followers_count: number;
  following_count: number;
  videos_count: number;
  created_at: string;
};

export type CommentAuthor = { username: string; display_name: string; avatar_url: string | null };

export type CommentRow = {
  id: string;
  body: string;
  created_at: string;
  author_id: string;
  author: CommentAuthor | null;
};
