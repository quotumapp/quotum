import { z } from "zod";

const slugSchema = z
	.string()
	.trim()
	.min(1)
	.max(80)
	.regex(/^[a-z0-9][a-z0-9_-]*$/, "must be a lowercase slug");
const nameSchema = z.string().trim().min(1).max(120);
const instanceSchema = z
	.object({
		key: slugSchema,
		environment: z.enum(["sandbox", "production", "internal"]),
		lifecycleStatus: z.enum(["inactive", "active", "suspended", "deactivating", "deactivated"]),
		issueCredential: z.boolean(),
	})
	.strict()
	.superRefine((instance, context) => {
		if (instance.environment === "internal" && instance.issueCredential) {
			context.addIssue({
				code: "custom",
				path: ["issueCredential"],
				message: "internal instances cannot receive project API credentials",
			});
		}
		if (instance.issueCredential && instance.lifecycleStatus !== "active") {
			context.addIssue({
				code: "custom",
				path: ["issueCredential"],
				message: "only active instances can receive project API credentials",
			});
		}
	});
const projectSchema = z
	.object({
		key: slugSchema,
		name: nameSchema,
		instances: z.array(instanceSchema).min(1).max(3),
	})
	.strict()
	.superRefine((project, context) => {
		const environments = new Set(project.instances.map((instance) => instance.environment));
		if (environments.size !== project.instances.length) {
			context.addIssue({
				code: "custom",
				path: ["instances"],
				message: "a logical project can contain at most one instance per environment",
			});
		}
		if (environments.has("internal") && environments.size !== 1) {
			context.addIssue({
				code: "custom",
				path: ["instances"],
				message: "an internal logical project cannot contain sandbox or production instances",
			});
		}
	});
const organizationSchema = z
	.object({
		slug: slugSchema,
		name: nameSchema,
		projects: z.array(projectSchema).min(1).max(100),
	})
	.strict();
const bootstrapManifestSchema = z
	.object({
		version: z.literal(1),
		organizations: z.array(organizationSchema).min(1).max(100),
	})
	.strict()
	.superRefine((manifest, context) => {
		const organizationSlugs = new Set<string>();
		const instanceKeys = new Set<string>();
		for (const [organizationIndex, organization] of manifest.organizations.entries()) {
			if (organizationSlugs.has(organization.slug)) {
				context.addIssue({
					code: "custom",
					path: ["organizations", organizationIndex, "slug"],
					message: "organization slugs must be unique",
				});
			}
			organizationSlugs.add(organization.slug);

			const projectKeys = new Set<string>();
			for (const [projectIndex, project] of organization.projects.entries()) {
				if (projectKeys.has(project.key)) {
					context.addIssue({
						code: "custom",
						path: ["organizations", organizationIndex, "projects", projectIndex, "key"],
						message: "logical project keys must be unique within an organization",
					});
				}
				projectKeys.add(project.key);

				for (const [instanceIndex, instance] of project.instances.entries()) {
					if (instanceKeys.has(instance.key)) {
						context.addIssue({
							code: "custom",
							path: [
								"organizations",
								organizationIndex,
								"projects",
								projectIndex,
								"instances",
								instanceIndex,
								"key",
							],
							message: "project instance keys must be globally unique",
						});
					}
					instanceKeys.add(instance.key);
				}
			}
		}
	});

export type PlatformBootstrapManifest = z.infer<typeof bootstrapManifestSchema>;
export type PlatformBootstrapInstance =
	PlatformBootstrapManifest["organizations"][number]["projects"][number]["instances"][number];

export function parsePlatformBootstrapManifest(value: string): PlatformBootstrapManifest {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(value);
	} catch {
		throw new Error("BILLING_PLATFORM_BOOTSTRAP_JSON must be valid JSON");
	}

	const parsed = bootstrapManifestSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error("BILLING_PLATFORM_BOOTSTRAP_JSON is invalid");
	}
	return parsed.data;
}
