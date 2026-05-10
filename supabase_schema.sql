-- videos table
CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    tags TEXT,
    thumbnail_url TEXT
);

-- video_stats table
CREATE TABLE video_stats (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,
    views INTEGER NOT NULL DEFAULT 0,
    comments INTEGER NOT NULL DEFAULT 0,
    mylists INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for querying recent stats efficiently
CREATE INDEX idx_video_stats_video_id_recorded_at ON video_stats(video_id, recorded_at DESC);
