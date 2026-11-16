<script lang="ts">
	import type { OpenCookieSnapshot } from "@opencookie-dev/core";
	import { getOpenCookieContext } from "@opencookie-dev/svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	type FixtureSnapshot = Pick<OpenCookieSnapshot, "readiness"> &
		Partial<Pick<OpenCookieSnapshot, "runtime">>;

	const { snapshot } = getOpenCookieContext<FixtureSnapshot>();
	const routeSequence = $derived.by(() => {
		const match = /^\/spa\/(\d+)$/u.exec(page.url.pathname);
		return match === null ? 0 : Number.parseInt(match[1] ?? "0", 10);
	});

	function appendAnalyticsResource(sequence: number): void {
		const script = document.createElement("script");
		script.type = "text/plain";
		script.dataset.ocResource = "analytics-script";
		script.dataset.ocCategory = "analytics";
		script.dataset.src =
			`http://tracker.sveltekit.opencookie.test:4400/analytics.js?resource=dynamic-${String(sequence)}`;
		document.head.append(script);
	}

	async function openDynamicRoute(): Promise<void> {
		const nextSequence = routeSequence + 1;
		appendAnalyticsResource(nextSequence);
		await goto(`/spa/${String(nextSequence)}`);
	}
</script>

<div data-fixture-root="sveltekit" data-ssr-fixture="sveltekit">
	<header class="site-header">
		<a class="brand" href="/">OpenCookie SvelteKit fixture</a>
		<button
			id="route-control"
			data-testid="route-control"
			type="button"
			onclick={openDynamicRoute}
		>
			Open dynamic route
		</button>
	</header>
	<main id="content-sentinel" data-testid="content-sentinel">
		<p class="eyebrow">SvelteKit SSR production fixture</p>
		<h1>Consent behavior should survive real application navigation.</h1>
		<p>
			This page uses the request-scoped Svelte context and connects its
			external store only after hydration.
		</p>
		<dl class="status-grid">
			<div>
				<dt>Route</dt>
				<dd>
					<output id="fixture-status" data-testid="fixture-status">
						{routeSequence === 0 ? "Initial route" : `Dynamic route ${String(routeSequence)}`}
					</output>
				</dd>
			</div>
			<div>
				<dt>Consent</dt>
				<dd data-testid="consent-status">
					{$snapshot.runtime?.consentEvaluation.status ?? "pending"}
				</dd>
			</div>
		</dl>
		<template
			data-oc-iframe
			title="Optional product video"
			data-oc-resource="product-video"
			data-oc-category="analytics"
			data-src="http://tracker.sveltekit.opencookie.test:4400/frame"
		></template>
	</main>
</div>
