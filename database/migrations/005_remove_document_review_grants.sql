UPDATE invite_codes
SET grants = COALESCE(
  (
    SELECT jsonb_agg(value ORDER BY value)
    FROM (
      SELECT DISTINCT value
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(invite_codes.grants) = 'array'
            THEN invite_codes.grants
          ELSE '[]'::jsonb
        END
      ) AS grant_item(value)
      WHERE value IN ('caseLawPack', 'evidencePack')
    ) AS controlled_grants
  ),
  '[]'::jsonb
),
updated_at = now()
WHERE jsonb_typeof(grants) <> 'array'
   OR NOT grants <@ '["caseLawPack", "evidencePack"]'::jsonb;

DELETE FROM access_grants
WHERE module NOT IN ('caseLawPack', 'evidencePack');

ALTER TABLE invite_codes
  ALTER COLUMN grants
  SET DEFAULT '["caseLawPack", "evidencePack"]'::jsonb;

ALTER TABLE invite_codes
  ADD CONSTRAINT invite_codes_grants_controlled
  CHECK (
    jsonb_typeof(grants) = 'array'
    AND grants <@ '["caseLawPack", "evidencePack"]'::jsonb
  );

ALTER TABLE access_grants
  ADD CONSTRAINT access_grants_module_controlled
  CHECK (module IN ('caseLawPack', 'evidencePack'));
