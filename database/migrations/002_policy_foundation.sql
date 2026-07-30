CREATE TABLE policy_rule_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  product_channel TEXT NOT NULL CHECK (product_channel IN ('main', 'ai')),
  active_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policy_rule_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id UUID NOT NULL REFERENCES policy_rule_sets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  definition JSONB NOT NULL,
  source_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  effective_from DATE NOT NULL,
  effective_to DATE,
  published_by UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_set_id, version),
  UNIQUE (rule_set_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (
    (status = 'published' AND published_at IS NOT NULL) OR
    (status <> 'published')
  )
);

ALTER TABLE policy_rule_sets
  ADD CONSTRAINT policy_rule_sets_active_version_fk
  FOREIGN KEY (id, active_version_id)
  REFERENCES policy_rule_versions(rule_set_id, id)
  ON DELETE SET NULL (active_version_id);

CREATE TABLE administrative_regions (
  code TEXT PRIMARY KEY CHECK (code ~ '^[0-9]{6}$'),
  name TEXT NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  level TEXT NOT NULL CHECK (level IN ('province', 'prefecture')),
  parent_code TEXT REFERENCES administrative_regions(code),
  status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  source_name TEXT NOT NULL CHECK (length(btrim(source_name)) > 0),
  source_url TEXT NOT NULL CHECK (source_url ~ '^https://'),
  source_snapshot_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (level = 'province' AND parent_code IS NULL) OR
    (level = 'prefecture' AND parent_code IS NOT NULL)
  )
);
CREATE INDEX administrative_regions_parent_idx
  ON administrative_regions(parent_code, status, name);

CREATE TABLE regional_parameters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region_code TEXT NOT NULL REFERENCES administrative_regions(code),
  region_name TEXT NOT NULL,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  parameter_type TEXT NOT NULL CHECK (
    parameter_type IN (
      'minimum_monthly_wage',
      'employee_average_monthly_wage'
    )
  ),
  amount_fen BIGINT NOT NULL CHECK (amount_fen > 0),
  source_name TEXT NOT NULL CHECK (length(btrim(source_name)) > 0),
  source_url TEXT NOT NULL CHECK (source_url ~ '^https://'),
  source_published_at DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'verified', 'stale')),
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (region_code, year, parameter_type)
);
CREATE INDEX regional_parameters_lookup_idx
  ON regional_parameters(region_code, parameter_type, year DESC);

ALTER TABLE assessments
  ADD COLUMN product_channel TEXT NOT NULL DEFAULT 'main'
    CHECK (product_channel IN ('main', 'ai', 'admin')),
  ADD COLUMN accuracy_level TEXT
    CHECK (accuracy_level IN ('verified', 'estimated', 'stale', 'unsupported')),
  ADD COLUMN rule_version_id UUID
    REFERENCES policy_rule_versions(id) ON DELETE SET NULL,
  ADD COLUMN input_snapshot JSONB,
  ADD COLUMN result_snapshot JSONB;

CREATE INDEX assessments_channel_time_idx
  ON assessments(product_channel, created_at DESC);

CREATE TABLE policy_calculation_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_id UUID NOT NULL UNIQUE
    REFERENCES assessments(id) ON DELETE CASCADE,
  rule_version_id UUID NOT NULL
    REFERENCES policy_rule_versions(id),
  regional_parameter_ids UUID[] NOT NULL DEFAULT '{}',
  input JSONB NOT NULL,
  output JSONB NOT NULL,
  input_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_capabilities (
  role TEXT NOT NULL CHECK (role IN ('user', 'admin', 'analyst')),
  capability TEXT NOT NULL CHECK (length(btrim(capability)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role, capability)
);

CREATE TABLE announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (length(btrim(title)) > 0),
  body TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  placement TEXT NOT NULL CHECK (placement IN ('main', 'ai', 'all')),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX policy_rule_versions_status_idx
  ON policy_rule_versions(rule_set_id, status, effective_from DESC);
