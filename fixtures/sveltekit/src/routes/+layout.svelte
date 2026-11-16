<script lang="ts">
	import { onMount } from "svelte";
	import { setOpenCookieContext } from "@opencookie-dev/svelte";

	import "../app.css";
	import { createFixtureOpenCookieStore } from "#lib/opencookie-store";

	let { children } = $props();
	const store = createFixtureOpenCookieStore();
	setOpenCookieContext(store);

	onMount(() => {
		document.documentElement.setAttribute("data-oc-hydrated", "true");
		void store.initialize();
	});
</script>

{@render children()}
