module.exports = {
  root: true,
  extends: ["expo"],
  ignorePatterns: ["dist/", "node_modules/", ".expo/"],
  overrides: [
    {
      files: ["*.config.js", "metro.config.js", "babel.config.js"],
      env: { node: true },
    },
  ],
};
