-- Baseline schema. Before 1.0 these files evolve in place; recreate databases instead of migrating.
-- Merchant platform: authentication, principals, sessions, memberships, onboarding, provisioning,
-- and OAuth state.

CREATE TABLE platform_auth_users (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name text NOT NULL,
	email text NOT NULL UNIQUE,
	email_verified boolean NOT NULL DEFAULT false,
	image text,
	two_factor_enabled boolean NOT NULL DEFAULT true,
	terms_version text,
	privacy_version text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_auth_accounts (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES platform_auth_users(id) ON DELETE CASCADE,
	account_id text NOT NULL,
	provider_id text NOT NULL,
	access_token text,
	refresh_token text,
	id_token text,
	access_token_expires_at timestamptz,
	refresh_token_expires_at timestamptz,
	scope text,
	password text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (provider_id, account_id)
);

CREATE INDEX platform_auth_accounts_user_idx ON platform_auth_accounts(user_id);

-- Better Auth sessions are transient authentication proofs, revoked on exchange.
CREATE TABLE platform_auth_sessions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES platform_auth_users(id) ON DELETE CASCADE,
	token text NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	ip_address text,
	user_agent text,
	auth_method text CHECK (auth_method IN ('password','google')),
	auth_issuer text,
	auth_subject text,
	proof_at timestamptz,
	-- A transient proof may serve exactly one OAuth authorization transaction.
	mcp_request_hash text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_auth_sessions_user_idx ON platform_auth_sessions(user_id);

CREATE INDEX platform_auth_sessions_expiry_idx ON platform_auth_sessions(expires_at);

CREATE TABLE platform_auth_verifications (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier text NOT NULL,
	value text NOT NULL,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_auth_verifications_identifier_idx ON platform_auth_verifications(identifier);

CREATE INDEX platform_auth_verifications_expiry_idx ON platform_auth_verifications(expires_at);

CREATE TABLE platform_auth_two_factors (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES platform_auth_users(id) ON DELETE CASCADE,
	secret text NOT NULL,
	backup_codes text NOT NULL,
	verified boolean DEFAULT true,
	failed_verification_count integer NOT NULL DEFAULT 0,
	locked_until timestamptz
);

CREATE INDEX platform_auth_two_factors_user_idx ON platform_auth_two_factors(user_id);

CREATE UNIQUE INDEX platform_auth_two_factors_user_unique ON platform_auth_two_factors(user_id);

CREATE INDEX platform_auth_two_factors_secret_idx ON platform_auth_two_factors(secret);

CREATE TABLE platform_auth_rate_limits (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	key text NOT NULL UNIQUE,
	count integer NOT NULL,
	last_request bigint NOT NULL
);

CREATE TABLE platform_principals (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	auth_user_id uuid NOT NULL UNIQUE REFERENCES platform_auth_users(id) ON DELETE RESTRICT,
	status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_external_identities (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
	issuer text NOT NULL,
	subject text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE(issuer,subject)
);

CREATE INDEX platform_identities_principal_idx ON platform_external_identities(principal_id);

CREATE TABLE platform_merchant_sessions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	csrf_hash text NOT NULL,
	auth_method text NOT NULL CHECK(auth_method IN ('password','google')),
	issuer text NOT NULL,
	subject text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_seen_at timestamptz NOT NULL DEFAULT now(),
	absolute_expires_at timestamptz NOT NULL,
	revoked_at timestamptz
);

CREATE INDEX platform_sessions_principal_idx ON platform_merchant_sessions(principal_id);

CREATE INDEX platform_sessions_expiry_idx ON platform_merchant_sessions(absolute_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE platform_memberships (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES platform_organizations(id) ON DELETE RESTRICT,
	principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
	role text NOT NULL CHECK(role IN ('Owner','Admin','Developer','Operator','Viewer')),
	status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','removed')),
	revision integer NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE(organization_id,principal_id)
);

CREATE INDEX platform_memberships_principal_idx ON platform_memberships(principal_id);

CREATE TABLE platform_invitations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES platform_organizations(id) ON DELETE RESTRICT,
	inviter_membership_id uuid NOT NULL REFERENCES platform_memberships(id) ON DELETE RESTRICT,
	inviter_revision integer NOT NULL,
	email text NOT NULL,
	role text NOT NULL CHECK(role IN ('Admin','Developer','Operator','Viewer')),
	token_hash text NOT NULL UNIQUE,
	status text NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','used','revoked','replaced')),
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	accepted_by uuid REFERENCES platform_principals(id) ON DELETE RESTRICT,
	accepted_at timestamptz,
	delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sent','failed'))
);

CREATE UNIQUE INDEX platform_invitations_live_idx ON platform_invitations(organization_id,email) WHERE status='valid';

CREATE INDEX platform_invitations_inviter_idx ON platform_invitations(inviter_membership_id);

CREATE INDEX platform_invitations_accepted_idx ON platform_invitations(accepted_by) WHERE accepted_by IS NOT NULL;

CREATE INDEX platform_invitations_expiry_idx ON platform_invitations(expires_at) WHERE status='valid';

CREATE TABLE platform_onboarding_drafts (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	principal_id uuid NOT NULL UNIQUE REFERENCES platform_principals(id) ON DELETE RESTRICT,
	organization_id uuid REFERENCES platform_organizations(id) ON DELETE RESTRICT,
	project_name text,
	project_key text,
	revision integer NOT NULL DEFAULT 1,
	status text NOT NULL DEFAULT 'organization' CHECK(status IN ('organization','project','provisioning','ready')),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_drafts_org_idx ON platform_onboarding_drafts(organization_id);

CREATE TABLE platform_provisioning_operations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	draft_id uuid NOT NULL UNIQUE REFERENCES platform_onboarding_drafts(id) ON DELETE RESTRICT,
	logical_project_id uuid NOT NULL UNIQUE REFERENCES platform_projects(id) ON DELETE RESTRICT,
	status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','provisioning','succeeded','failed','partially_provisioned')),
	error_code text,
	credential_delivery text NOT NULL DEFAULT 'available' CHECK(credential_delivery IN ('available','delivered','unavailable')),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_provisioning_steps (
	operation_id uuid NOT NULL REFERENCES platform_provisioning_operations(id) ON DELETE RESTRICT,
	environment text NOT NULL CHECK(environment IN ('sandbox','production')),
	status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed')),
	PRIMARY KEY(operation_id,environment)
);

CREATE TABLE platform_step_up_grants (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	session_id uuid NOT NULL REFERENCES platform_merchant_sessions(id) ON DELETE CASCADE,
	organization_id uuid NOT NULL REFERENCES platform_organizations(id) ON DELETE RESTRICT,
	scope jsonb NOT NULL,
	action text NOT NULL,
	target text NOT NULL,
	return_to text NOT NULL,
	request jsonb,
	token_hash text UNIQUE,
	expires_at timestamptz NOT NULL,
	verified_at timestamptz,
	consumed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_step_up_session_idx ON platform_step_up_grants(session_id);

CREATE INDEX platform_step_up_org_idx ON platform_step_up_grants(organization_id);

CREATE TABLE platform_service_principals (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name text NOT NULL UNIQUE,
	token_hash text NOT NULL UNIQUE,
	active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_policy_acceptances (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
	terms_version text NOT NULL,
	privacy_version text NOT NULL,
	accepted_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE(principal_id,terms_version,privacy_version)
);

CREATE TABLE platform_audit_events (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	principal_id uuid REFERENCES platform_principals(id) ON DELETE RESTRICT,
	organization_id uuid REFERENCES platform_organizations(id) ON DELETE RESTRICT,
	action text NOT NULL,
	target text,
	metadata jsonb NOT NULL DEFAULT '{}',
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_audit_principal_idx ON platform_audit_events(principal_id,created_at);

CREATE INDEX platform_audit_org_idx ON platform_audit_events(organization_id,created_at);

CREATE TABLE platform_rate_limits (
	key_hash text PRIMARY KEY,
	count integer NOT NULL CHECK(count >= 0),
	reset_at timestamptz NOT NULL
);

CREATE INDEX platform_rate_limits_reset_idx ON platform_rate_limits(reset_at);

CREATE TABLE platform_auth_links (
	token_hash text PRIMARY KEY,
	kind text NOT NULL CHECK(kind IN ('verification','reset','signup','invitation')),
	payload jsonb NOT NULL DEFAULT '{}',
	expires_at timestamptz NOT NULL,
	consumed_at timestamptz
);

CREATE INDEX platform_auth_links_expiry_idx ON platform_auth_links(expires_at);

CREATE TABLE platform_idempotency (
	principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
	key text NOT NULL,
	request_hash text NOT NULL,
	result jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY(principal_id,key)
);

CREATE TABLE platform_connection_oauth_states (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	state_hash text NOT NULL UNIQUE,
	project_instance_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
	session_id uuid NOT NULL REFERENCES platform_merchant_sessions(id) ON DELETE RESTRICT,
	expected_revision integer NOT NULL CHECK(expected_revision >= 0),
	settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
	expires_at timestamptz NOT NULL,
	consumed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_connection_oauth_instance_idx ON platform_connection_oauth_states(project_instance_id);

CREATE INDEX platform_connection_oauth_principal_idx ON platform_connection_oauth_states(principal_id);

CREATE INDEX platform_connection_oauth_session_idx ON platform_connection_oauth_states(session_id);

CREATE INDEX platform_connection_oauth_expiry_idx ON platform_connection_oauth_states(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE platform_auth_jwks (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	public_key text NOT NULL,
	private_key text NOT NULL,
	created_at timestamptz NOT NULL,
	expires_at timestamptz,
	alg text,
	crv text
);

CREATE TABLE platform_auth_oauth_clients (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	client_id text NOT NULL UNIQUE,
	client_secret text,
	client_discovery_id text,
	disabled boolean DEFAULT false,
	skip_consent boolean,
	enable_end_session boolean,
	subject_type text,
	scopes text[],
	client_credentials_scopes text[],
	user_id uuid REFERENCES platform_auth_users(id) ON DELETE CASCADE,
	created_at timestamptz,
	updated_at timestamptz,
	name text,
	uri text,
	icon text,
	contacts text[],
	tos text,
	policy text,
	software_id text,
	software_version text,
	software_statement text,
	redirect_uris text[] NOT NULL,
	post_logout_redirect_uris text[],
	backchannel_logout_uri text,
	backchannel_logout_session_required boolean,
	token_endpoint_auth_method text,
	application_type text,
	jwks text,
	jwks_uri text,
	grant_types text[],
	response_types text[],
	require_p_k_c_e boolean,
	dpop_bound_access_tokens boolean DEFAULT false,
	reference_id text,
	metadata jsonb
);

CREATE INDEX platform_auth_oauth_clients_user_id_idx ON platform_auth_oauth_clients(user_id);

INSERT INTO platform_auth_oauth_clients(client_id,name,redirect_uris,scopes,grant_types,response_types,token_endpoint_auth_method,require_p_k_c_e,skip_consent,created_at,updated_at)
VALUES
('quotum-claude-code','Claude Code',ARRAY['http://localhost:8788/callback'],ARRAY['quotum.read','offline_access'],ARRAY['authorization_code','refresh_token'],ARRAY['code'],'none',true,false,now(),now()),
('quotum-cursor','Cursor',ARRAY['http://localhost:8787/callback'],ARRAY['quotum.read','offline_access'],ARRAY['authorization_code','refresh_token'],ARRAY['code'],'none',true,false,now(),now());

CREATE TABLE platform_auth_oauth_resources (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	identifier text NOT NULL UNIQUE,
	name text NOT NULL,
	access_token_ttl integer,
	refresh_token_ttl integer,
	signing_algorithm text,
	signing_key_id text,
	allowed_scopes text[],
	custom_claims jsonb,
	dpop_bound_access_tokens_required boolean DEFAULT false,
	disabled boolean DEFAULT false,
	created_at timestamptz,
	updated_at timestamptz,
	policy_version integer DEFAULT 1,
	metadata jsonb
);

CREATE TABLE platform_auth_oauth_client_resources (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	client_id text NOT NULL REFERENCES platform_auth_oauth_clients(client_id) ON DELETE CASCADE,
	resource_id text NOT NULL REFERENCES platform_auth_oauth_resources(identifier) ON DELETE CASCADE,
	metadata jsonb,
	created_at timestamptz
);

CREATE INDEX platform_auth_oauth_client_resources_client_id_idx ON platform_auth_oauth_client_resources(client_id);

CREATE INDEX platform_auth_oauth_client_resources_resource_id_idx ON platform_auth_oauth_client_resources(resource_id);

CREATE TABLE platform_auth_oauth_refresh_tokens (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	token text NOT NULL UNIQUE,
	client_id text NOT NULL REFERENCES platform_auth_oauth_clients(client_id) ON DELETE CASCADE,
	session_id uuid REFERENCES platform_auth_sessions(id) ON DELETE SET NULL,
	user_id uuid NOT NULL REFERENCES platform_auth_users(id) ON DELETE CASCADE,
	reference_id text,
	authorization_code_id text,
	resources text[],
	requested_user_info_claims text[],
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL,
	revoked timestamptz,
	rotated_at timestamptz,
	rotation_replay_response text,
	rotation_replay_expires_at timestamptz,
	auth_time timestamptz,
	confirmation jsonb,
	scopes text[] NOT NULL
);

CREATE INDEX platform_auth_oauth_refresh_tokens_client_id_idx ON platform_auth_oauth_refresh_tokens(client_id);

CREATE INDEX platform_auth_oauth_refresh_tokens_session_id_idx ON platform_auth_oauth_refresh_tokens(session_id);

CREATE INDEX platform_auth_oauth_refresh_tokens_user_id_idx ON platform_auth_oauth_refresh_tokens(user_id);

CREATE INDEX platform_auth_oauth_refresh_tokens_authorization_code_id_idx ON platform_auth_oauth_refresh_tokens(authorization_code_id);

CREATE TABLE platform_auth_oauth_access_tokens (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	token text NOT NULL UNIQUE,
	client_id text NOT NULL REFERENCES platform_auth_oauth_clients(client_id) ON DELETE CASCADE,
	session_id uuid REFERENCES platform_auth_sessions(id) ON DELETE SET NULL,
	user_id uuid REFERENCES platform_auth_users(id) ON DELETE CASCADE,
	reference_id text,
	authorization_code_id text,
	resources text[],
	requested_user_info_claims text[],
	refresh_id uuid REFERENCES platform_auth_oauth_refresh_tokens(id) ON DELETE CASCADE,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL,
	revoked timestamptz,
	confirmation jsonb,
	scopes text[] NOT NULL
);

CREATE INDEX platform_auth_oauth_access_tokens_client_id_idx ON platform_auth_oauth_access_tokens(client_id);

CREATE INDEX platform_auth_oauth_access_tokens_session_id_idx ON platform_auth_oauth_access_tokens(session_id);

CREATE INDEX platform_auth_oauth_access_tokens_user_id_idx ON platform_auth_oauth_access_tokens(user_id);

CREATE INDEX platform_auth_oauth_access_tokens_authorization_code_id_idx ON platform_auth_oauth_access_tokens(authorization_code_id);

CREATE INDEX platform_auth_oauth_access_tokens_refresh_id_idx ON platform_auth_oauth_access_tokens(refresh_id);

CREATE TABLE platform_auth_oauth_consents (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	client_id text NOT NULL REFERENCES platform_auth_oauth_clients(client_id) ON DELETE CASCADE,
	user_id uuid REFERENCES platform_auth_users(id) ON DELETE CASCADE,
	reference_id text,
	resources text[],
	requested_user_info_claims text[],
	scopes text[] NOT NULL,
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL
);

CREATE INDEX platform_auth_oauth_consents_client_id_idx ON platform_auth_oauth_consents(client_id);

CREATE INDEX platform_auth_oauth_consents_user_id_idx ON platform_auth_oauth_consents(user_id);

CREATE TABLE platform_auth_oauth_client_assertions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	expires_at timestamptz NOT NULL
);

CREATE TABLE platform_mcp_authorizations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE CASCADE,
	organization_id uuid NOT NULL REFERENCES platform_organizations(id) ON DELETE CASCADE,
	project_instance_id uuid NOT NULL,
	client_id text NOT NULL,
	client_name text NOT NULL,
	proof_session_id uuid UNIQUE REFERENCES platform_auth_sessions(id) ON DELETE SET NULL,
	code_hash text UNIQUE,
	created_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	approved_at timestamptz,
	revoked_at timestamptz,
	CHECK (expires_at > created_at)
);
CREATE INDEX platform_mcp_authorizations_owner_idx ON platform_mcp_authorizations(principal_id, project_instance_id);

-- Status changes invalidate grants even when no request arrives during the suspension.
CREATE FUNCTION platform_revoke_mcp_authorizations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	affected_principal uuid;
	affected_organization uuid;
BEGIN
	IF NEW.status <> 'active' AND OLD.status <> NEW.status THEN
		IF TG_TABLE_NAME = 'platform_principals' THEN
			affected_principal := NEW.id;
		ELSE
			affected_principal := NEW.principal_id;
			affected_organization := NEW.organization_id;
		END IF;
		UPDATE platform_mcp_authorizations SET revoked_at = now()
		WHERE principal_id = affected_principal
		AND (affected_organization IS NULL OR organization_id = affected_organization)
		AND revoked_at IS NULL;
		UPDATE platform_auth_oauth_refresh_tokens SET revoked = now(), rotation_replay_response = NULL, rotation_replay_expires_at = NULL
		WHERE authorization_code_id IN (
			SELECT code_hash FROM platform_mcp_authorizations WHERE principal_id = affected_principal
			AND (affected_organization IS NULL OR organization_id = affected_organization) AND revoked_at IS NOT NULL
		);
	END IF;
	RETURN NEW;
END;
$$;
CREATE TRIGGER platform_principals_revoke_mcp AFTER UPDATE OF status ON platform_principals
FOR EACH ROW EXECUTE FUNCTION platform_revoke_mcp_authorizations();
CREATE TRIGGER platform_memberships_revoke_mcp AFTER UPDATE OF status ON platform_memberships
FOR EACH ROW EXECUTE FUNCTION platform_revoke_mcp_authorizations();
