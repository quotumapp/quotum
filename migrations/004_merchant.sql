-- Baseline schema. Before 1.0 these files evolve in place; recreate databases instead of migrating.
-- Merchant platform: authentication, principals, sessions, memberships, onboarding, provisioning,
-- and OAuth state.

CREATE TABLE platform_auth_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE,
 email_verified boolean NOT NULL DEFAULT false, image text, two_factor_enabled boolean NOT NULL DEFAULT true,
 terms_version text, privacy_version text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_auth_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES platform_auth_users(id) ON DELETE CASCADE,
 account_id text NOT NULL, provider_id text NOT NULL, issuer text NOT NULL,
 access_token text, refresh_token text, id_token text, access_token_expires_at timestamptz,
 refresh_token_expires_at timestamptz, scope text, password text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (issuer, account_id)
);

CREATE INDEX platform_auth_accounts_user_idx ON platform_auth_accounts(user_id);

-- Better Auth sessions are transient authentication proofs, revoked on exchange.
CREATE TABLE platform_auth_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES platform_auth_users(id) ON DELETE CASCADE,
 token text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, ip_address text, user_agent text,
 auth_method text CHECK (auth_method IN ('password','google')), auth_issuer text, auth_subject text,
 proof_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_auth_sessions_user_idx ON platform_auth_sessions(user_id);

CREATE INDEX platform_auth_sessions_expiry_idx ON platform_auth_sessions(expires_at);

CREATE TABLE platform_auth_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), identifier text NOT NULL, value text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_auth_verifications_identifier_idx ON platform_auth_verifications(identifier);

CREATE INDEX platform_auth_verifications_expiry_idx ON platform_auth_verifications(expires_at);

CREATE TABLE platform_auth_two_factors (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES platform_auth_users(id) ON DELETE CASCADE,
 secret text NOT NULL, backup_codes text NOT NULL, verified boolean DEFAULT true,
 failed_verification_count integer NOT NULL DEFAULT 0, locked_until timestamptz
);

CREATE INDEX platform_auth_two_factors_user_idx ON platform_auth_two_factors(user_id);

CREATE UNIQUE INDEX platform_auth_two_factors_user_unique ON platform_auth_two_factors(user_id);

CREATE INDEX platform_auth_two_factors_secret_idx ON platform_auth_two_factors(secret);

CREATE TABLE platform_auth_rate_limits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE, count integer NOT NULL, last_request bigint NOT NULL
);

CREATE TABLE platform_principals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_user_id uuid NOT NULL UNIQUE REFERENCES platform_auth_users(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_external_identities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
 issuer text NOT NULL, subject text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(issuer,subject)
);

CREATE INDEX platform_identities_principal_idx ON platform_external_identities(principal_id);

CREATE TABLE platform_merchant_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE, csrf_hash text NOT NULL, auth_method text NOT NULL CHECK(auth_method IN ('password','google')),
 issuer text NOT NULL, subject text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 last_seen_at timestamptz NOT NULL DEFAULT now(), absolute_expires_at timestamptz NOT NULL,
 revoked_at timestamptz
);

CREATE INDEX platform_sessions_principal_idx ON platform_merchant_sessions(principal_id);

CREATE INDEX platform_sessions_expiry_idx ON platform_merchant_sessions(absolute_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE platform_memberships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES platform_organizations(id) ON DELETE RESTRICT,
 principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
 role text NOT NULL CHECK(role IN ('Owner','Admin','Developer','Operator','Viewer')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','removed')),
 revision integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,principal_id)
);

CREATE INDEX platform_memberships_principal_idx ON platform_memberships(principal_id);

CREATE TABLE platform_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES platform_organizations(id) ON DELETE RESTRICT,
 inviter_membership_id uuid NOT NULL REFERENCES platform_memberships(id) ON DELETE RESTRICT, inviter_revision integer NOT NULL,
 email text NOT NULL, role text NOT NULL CHECK(role IN ('Admin','Developer','Operator','Viewer')),
 token_hash text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'valid' CHECK(status IN ('valid','used','revoked','replaced')),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), accepted_by uuid REFERENCES platform_principals(id) ON DELETE RESTRICT,
 accepted_at timestamptz, delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sent','failed'))
);

CREATE UNIQUE INDEX platform_invitations_live_idx ON platform_invitations(organization_id,email) WHERE status='valid';

CREATE INDEX platform_invitations_inviter_idx ON platform_invitations(inviter_membership_id);

CREATE INDEX platform_invitations_accepted_idx ON platform_invitations(accepted_by) WHERE accepted_by IS NOT NULL;

CREATE INDEX platform_invitations_expiry_idx ON platform_invitations(expires_at) WHERE status='valid';

CREATE TABLE platform_onboarding_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_id uuid NOT NULL UNIQUE REFERENCES platform_principals(id) ON DELETE RESTRICT,
 organization_id uuid REFERENCES platform_organizations(id) ON DELETE RESTRICT, project_name text, project_key text,
 revision integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'organization' CHECK(status IN ('organization','project','provisioning','ready')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_drafts_org_idx ON platform_onboarding_drafts(organization_id);

CREATE TABLE platform_provisioning_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL UNIQUE REFERENCES platform_onboarding_drafts(id) ON DELETE RESTRICT,
 logical_project_id uuid NOT NULL UNIQUE REFERENCES platform_projects(id) ON DELETE RESTRICT,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','provisioning','succeeded','failed','partially_provisioned')),
 error_code text, credential_delivery text NOT NULL DEFAULT 'available' CHECK(credential_delivery IN ('available','delivered','unavailable')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_provisioning_steps (
 operation_id uuid NOT NULL REFERENCES platform_provisioning_operations(id) ON DELETE RESTRICT,
 environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed')),
 PRIMARY KEY(operation_id,environment)
);

CREATE TABLE platform_step_up_grants (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES platform_merchant_sessions(id) ON DELETE CASCADE,
 organization_id uuid NOT NULL REFERENCES platform_organizations(id) ON DELETE RESTRICT,
 scope jsonb NOT NULL, action text NOT NULL, target text NOT NULL, return_to text NOT NULL, request jsonb,
 token_hash text UNIQUE, expires_at timestamptz NOT NULL, verified_at timestamptz, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_step_up_session_idx ON platform_step_up_grants(session_id);

CREATE INDEX platform_step_up_org_idx ON platform_step_up_grants(organization_id);

CREATE TABLE platform_service_principals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE, token_hash text NOT NULL UNIQUE,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_policy_acceptances (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
 terms_version text NOT NULL, privacy_version text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(), UNIQUE(principal_id,terms_version,privacy_version)
);

CREATE TABLE platform_audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_id uuid REFERENCES platform_principals(id) ON DELETE RESTRICT,
 organization_id uuid REFERENCES platform_organizations(id) ON DELETE RESTRICT, action text NOT NULL, target text,
 metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_audit_principal_idx ON platform_audit_events(principal_id,created_at);

CREATE INDEX platform_audit_org_idx ON platform_audit_events(organization_id,created_at);

CREATE TABLE platform_rate_limits (
 key_hash text PRIMARY KEY, count integer NOT NULL CHECK(count >= 0), reset_at timestamptz NOT NULL
);

CREATE INDEX platform_rate_limits_reset_idx ON platform_rate_limits(reset_at);

CREATE TABLE platform_auth_links (
 token_hash text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('verification','reset','signup','invitation')),
 payload jsonb NOT NULL DEFAULT '{}', expires_at timestamptz NOT NULL, consumed_at timestamptz
);

CREATE INDEX platform_auth_links_expiry_idx ON platform_auth_links(expires_at);

CREATE TABLE platform_idempotency (
 principal_id uuid NOT NULL REFERENCES platform_principals(id) ON DELETE RESTRICT,
 key text NOT NULL, request_hash text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(principal_id,key)
);
