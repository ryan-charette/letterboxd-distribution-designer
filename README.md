# Letterboxd Distribution Designer

Design your perfect Letterboxd ratings chart.

Letterboxd Distribution Designer is a small interactive web app for shaping a movie-rating distribution. Start with a preset curve, drag the points until the shape feels right, then see how that curve translates into a Letterboxd-style ratings bar chart.

It is built for people who are just a little too obsessed with having a beautiful ratings spread.

> This project is independently made and is not affiliated with Letterboxd.

## Features

- Drag points to reshape the rating curve
- Move peaks left and right to shift the mode of the distribution
- Soft-selection moves nearby points with the selected point
- Automatic handle rebalancing prevents jagged, bunched-up curves
- Toggle half-star ratings on or off
- Enter the number of movies and see expected counts per rating
- Letterboxd-inspired dark UI with green star accents
- Presets for normal, skewed, and bimodal distributions

## Demo

```md
![Letterboxd Distribution Designer demo](./public/demo.png)
```

## Getting started

### Prerequisites

- Node.js 18+
- npm, pnpm, yarn, or bun

### Install

```bash
npm install
```

### Run locally

```bash
npm run dev
```

Then open the local URL printed in your terminal.

### Build

```bash
npm run build
```

### Preview production build

```bash
npm run preview
```

## Project structure

```txt
letterboxd-distribution-designer/
├─ public/
│  └─ favicon.svg
├─ src/
│  ├─ App.jsx
│  ├─ index.css
│  └─ main.jsx
├─ .gitignore
├─ index.html
├─ package.json
├─ postcss.config.js
├─ README.md
├─ tailwind.config.js
└─ vite.config.js
```

## How it works

The app stores the rating curve as a set of draggable control points. The curve is sampled into a continuous shape, then converted into either 5 whole-star bins or 10 half-star bins.

When you drag a point vertically, nearby points move with it so the curve stays smooth. When you drag a point horizontally, points on either side are redistributed so the handles do not bunch up or stretch too far apart.

The bar chart takes the probability in each bin and multiplies it by the number of movies entered by the user. Counts are rounded using a largest-remainder method so the total still matches the movie count.

## License

MIT License. See `LICENSE` for details.
