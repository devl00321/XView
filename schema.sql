-- Run this in your Supabase SQL Editor

CREATE TABLE devices (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id UUID REFERENCES auth.users NOT NULL,
  device_id VARCHAR(12) UNIQUE NOT NULL,
  access_password VARCHAR NOT NULL,
  device_name VARCHAR,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;

-- Users can only read and manage their own devices
CREATE POLICY "Users can manage their own devices"
ON devices
FOR ALL
USING (auth.uid() = user_id);
