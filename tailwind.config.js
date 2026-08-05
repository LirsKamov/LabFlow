/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
    "./hooks/**/*.{js,jsx,ts,tsx}",
    "./services/**/*.{js,jsx,ts,tsx}",
  ],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "#eff6ff",
          100: "#dbeafe",
          200: "#bfdbfe",
          300: "#93c5fd",
          400: "#60a5fa",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
          800: "#1e40af",
          900: "#1e3a8a",
          950: "#172554",
        },
        lab: {
          green: "#10b981",
          red: "#ef4444",
          yellow: "#eab308",
          blue: "#3b82f6",
          purple: "#8b5cf6",
          gray: "#6b7280",
        },
      },
      fontFamily: {
        // Android 上仅 ["System"] 不合法，需显式回退 sans-serif
        sans: ["System", "sans-serif"],
        // 注：SpaceMono 字体从未被 expo-font 加载，此配置无实际效果，仅保留作占位
        mono: ["SpaceMono", "monospace"],
      },
    },
  },
  plugins: [],
};
