import openCookie from "../dist/index.js";

export default {
  integrations: [
    openCookie({
      entrypoint: "/src/opencookie.client.ts",
    }),
  ],
};
