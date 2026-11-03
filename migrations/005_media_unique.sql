-- One media_assets row per stored object. Purged assets all share the
-- "[purged]" marker, so they are left out of the index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_assets_storage_ref
  ON media_assets (storage_ref) WHERE storage_ref <> '[purged]';
