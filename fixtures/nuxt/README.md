# Nuxt Minimal Starter

> This fixture is the current Nuxt 4 minimal starter, adapted for the
> OpenCookie browser matrix. Exact scaffold provenance is recorded in
> `.scaffold.json`.

Look at the [Nuxt documentation](https://nuxt.com/docs/getting-started/introduction) to learn more.

## Setup

Install workspace dependencies from the OpenCookie repository root. This
fixture does not run `nuxt prepare` during installation because its local
OpenCookie adapters have not been built yet. The workspace production build
generates the Nuxt types. After the adapters have been built, contributors can
regenerate only these types with
`pnpm --filter @opencookie-fixtures/nuxt generate:types`.

Make sure to install dependencies:

```bash
# npm
npm install

# pnpm
pnpm install

# yarn
yarn install

# bun
bun install
```

## Development Server

Start the development server on `http://localhost:3000`:

```bash
# npm
npm run dev

# pnpm
pnpm dev

# yarn
yarn dev

# bun
bun run dev
```

## Production

Build the application for production:

```bash
# npm
npm run build

# pnpm
pnpm build

# yarn
yarn build

# bun
bun run build
```

Locally preview production build:

```bash
# npm
npm run preview

# pnpm
pnpm preview

# yarn
yarn preview

# bun
bun run preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.
