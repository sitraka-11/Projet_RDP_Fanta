/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      keyframes: {
        pop: {
          "0%": { transform: "scale(1)" },
          "35%": { transform: "scale(1.28)" },
          "100%": { transform: "scale(1)" },
        },
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "glow-pulse": {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
      },
      animation: {
        pop: "pop 420ms cubic-bezier(0.34,1.56,0.64,1)",
        "fade-in": "fade-in 300ms ease-out",
        "glow-pulse": "glow-pulse 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
