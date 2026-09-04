-- Baseline schema. Before 1.0 these files evolve in place; recreate databases instead of migrating.
-- Platform: organizations, logical projects, project instances, and credentials.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE platform_organizations (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	slug TEXT COLLATE "C" NOT NULL,
	name TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT platform_organizations_slug_format_check CHECK (
		char_length(slug) BETWEEN 1 AND 80
		AND slug ~ '^[a-z0-9][a-z0-9_-]*$'
	),
	CONSTRAINT platform_organizations_name_check CHECK (
		char_length(name) BETWEEN 1 AND 120
		AND name = btrim(name)
	)
);

CREATE UNIQUE INDEX idx_platform_organizations_slug
	ON platform_organizations (slug);

CREATE TABLE platform_projects (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	organization_id UUID NOT NULL REFERENCES platform_organizations(id) ON DELETE RESTRICT,
	key TEXT COLLATE "C" NOT NULL,
	name TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT platform_projects_key_format_check CHECK (
		char_length(key) BETWEEN 1 AND 80
		AND key ~ '^[a-z0-9][a-z0-9_-]*$'
	),
	CONSTRAINT platform_projects_name_check CHECK (
		char_length(name) BETWEEN 1 AND 120
		AND name = btrim(name)
	),
	CONSTRAINT platform_projects_organization_key_unique UNIQUE (organization_id, key)
);

CREATE INDEX idx_platform_projects_organization
	ON platform_projects (organization_id);

CREATE TABLE IF NOT EXISTS projects (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	key TEXT NOT NULL,
	name TEXT NOT NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	published_catalog_revision_id BIGINT,
	platform_project_id UUID NOT NULL REFERENCES platform_projects(id) ON DELETE RESTRICT,
	environment TEXT NOT NULL,
	lifecycle_status TEXT NOT NULL,
	internal_project BOOLEAN NOT NULL,
	CONSTRAINT projects_key_format_check CHECK (
		char_length(key) BETWEEN 1 AND 80
		AND key ~ '^[a-z0-9][a-z0-9_-]*$'
	),
	CONSTRAINT projects_name_check CHECK (
		char_length(name) BETWEEN 1 AND 120
		AND name = btrim(name)
	),
	CONSTRAINT projects_environment_check CHECK (
		environment IN ('sandbox', 'production', 'internal')
	),
	CONSTRAINT projects_lifecycle_status_check CHECK (
		lifecycle_status IN ('inactive', 'active', 'suspended', 'deactivating', 'deactivated')
	),
	CONSTRAINT projects_internal_environment_check CHECK (
		internal_project = (environment = 'internal')
	),
	CONSTRAINT projects_platform_project_environment_unique UNIQUE (
		platform_project_id,
		environment
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_projects_key
	ON projects (key);

CREATE INDEX IF NOT EXISTS idx_billing_projects_published_catalog_revision
	ON projects (published_catalog_revision_id)
	WHERE published_catalog_revision_id IS NOT NULL;

CREATE INDEX idx_billing_projects_platform_project
	ON projects (platform_project_id);

CREATE TABLE platform_project_api_credentials (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_instance_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	audience TEXT COLLATE "C" NOT NULL DEFAULT 'billing_api',
	secret_verifier BYTEA NOT NULL,
	expires_at TIMESTAMPTZ,
	revoked_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT platform_project_api_credentials_audience_check CHECK (audience = 'billing_api'),
	CONSTRAINT platform_project_api_credentials_verifier_check CHECK (
		octet_length(secret_verifier) = 32
	),
	CONSTRAINT platform_project_api_credentials_expiry_check CHECK (
		expires_at IS NULL OR expires_at > created_at
	),
	CONSTRAINT platform_project_api_credentials_revocation_check CHECK (
		revoked_at IS NULL OR revoked_at >= created_at
	)
);

CREATE INDEX idx_platform_project_api_credentials_instance
	ON platform_project_api_credentials (project_instance_id);

CREATE INDEX idx_platform_project_api_credentials_active_instance
	ON platform_project_api_credentials (project_instance_id, created_at DESC)
	WHERE revoked_at IS NULL;
