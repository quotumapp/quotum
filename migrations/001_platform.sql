-- Baseline schema. Before 1.0 these files evolve in place; recreate databases instead of migrating.
-- Platform: billing projects.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS projects (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	key TEXT NOT NULL,
	name TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT true,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	published_catalog_revision_id BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_projects_key
	ON projects (key);

INSERT INTO projects (key, name, active)
VALUES ('voysee', 'Voysee', true)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION resolve_project_id(p_project_key TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
	resolved_project_id UUID;
BEGIN
	SELECT id
	INTO resolved_project_id
	FROM projects
	WHERE key = p_project_key
		AND active = true;

	IF resolved_project_id IS NULL THEN
		RAISE EXCEPTION 'Unknown or inactive billing project: %', p_project_key
			USING ERRCODE = 'foreign_key_violation';
	END IF;

	RETURN resolved_project_id;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_billing_projects_published_catalog_revision
	ON projects (published_catalog_revision_id)
	WHERE published_catalog_revision_id IS NOT NULL;
