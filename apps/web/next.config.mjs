/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The SDK is plain .ts consumed straight from source rather than a build step.
  transpilePackages: ['@rung/sdk'],
};
