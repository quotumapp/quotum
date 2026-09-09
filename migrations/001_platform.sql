-- Baseline schema. Before 1.0 these files evolve in place; recreate databases instead of migrating.
-- Platform: organizations, logical projects, project instances, credentials, and customer connections.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE platform_organizations (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	slug TEXT COLLATE "C" NOT NULL,
	name TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	member_limit integer NOT NULL DEFAULT 3 CHECK(member_limit > 0),
	production_limit integer NOT NULL DEFAULT 1 CHECK(production_limit >= 0),
	status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','removed')),
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

CREATE TABLE platform_connections (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_instance_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	kind text NOT NULL CHECK (kind IN ('stripe','apple','google','projection')),
	revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
	enabled boolean NOT NULL DEFAULT false,
	active_version_id uuid,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	stripe_account_id text,
	stripe_livemode boolean,
	UNIQUE(project_instance_id,kind),
	UNIQUE(id,project_instance_id),
	CONSTRAINT platform_connections_stripe_identity_check CHECK ((stripe_account_id IS NULL AND stripe_livemode IS NULL) OR (kind='stripe' AND stripe_account_id IS NOT NULL AND stripe_livemode IS NOT NULL))
);

CREATE INDEX platform_connections_active_version_idx ON platform_connections(id,active_version_id) WHERE active_version_id IS NOT NULL;

CREATE UNIQUE INDEX platform_connections_stripe_account_mode_idx ON platform_connections(stripe_account_id,stripe_livemode) WHERE stripe_account_id IS NOT NULL;

CREATE TABLE platform_connection_versions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	connection_id uuid NOT NULL,
	project_instance_id uuid NOT NULL,
	expected_revision integer NOT NULL CHECK(expected_revision >= 0),
	settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
	status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','validated','active','retired','expired')),
	validation jsonb,
	validated_at timestamptz,
	event_verified_at timestamptz,
	external_identity text,
	request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
	request_fingerprint text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
	refresh_lease_id uuid,
	refresh_lease_until timestamptz,
	FOREIGN KEY(connection_id,project_instance_id) REFERENCES platform_connections(id,project_instance_id) ON DELETE RESTRICT,
	UNIQUE(connection_id,id),
	UNIQUE(connection_id,request_key)
);

CREATE INDEX platform_connection_versions_instance_idx ON platform_connection_versions(project_instance_id);

CREATE INDEX platform_connection_versions_expiry_idx ON platform_connection_versions(expires_at) WHERE status IN ('draft','validated');

CREATE TABLE platform_connection_secrets (
	connection_id uuid NOT NULL,
	version_id uuid NOT NULL,
	purpose text NOT NULL CHECK(length(purpose) BETWEEN 1 AND 80),
	envelope jsonb NOT NULL CHECK(jsonb_typeof(envelope)='object'),
	PRIMARY KEY(connection_id,version_id,purpose),
	FOREIGN KEY(connection_id,version_id) REFERENCES platform_connection_versions(connection_id,id) ON DELETE RESTRICT
);

CREATE TABLE platform_connection_operations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	project_instance_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	request_key text NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
	action text NOT NULL,
	request_fingerprint text NOT NULL,
	result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE(project_instance_id,request_key)
);

CREATE TABLE platform_stripe_app_events (
	event_id text PRIMARY KEY,
	account_id text NOT NULL,
	livemode boolean NOT NULL,
	payload jsonb NOT NULL,
	processed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	next_attempt_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_stripe_app_events_pending_idx ON platform_stripe_app_events(account_id,livemode,created_at) WHERE processed_at IS NULL;

CREATE INDEX platform_stripe_app_events_retry_idx ON platform_stripe_app_events(next_attempt_at,created_at) WHERE processed_at IS NULL;

-- Constraints on tables defined in earlier files that reference this file's tables.
ALTER TABLE platform_connections
	ADD CONSTRAINT platform_connections_active_version_fk
 FOREIGN KEY(id,active_version_id) REFERENCES platform_connection_versions(connection_id,id) DEFERRABLE INITIALLY DEFERRED;
