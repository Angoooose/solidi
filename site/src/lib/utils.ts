import { createCn } from "cn/config"

/*
 * Tell the class merger about our type scale (global.css @theme --text-*). Without this it reads
 * `text-credit` as a colour and drops it when a colour like `text-white` follows.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["display", "heading", "latin", "reading", "subtitle", "body", "ui", "label", "credit"] },
      ],
    },
  },
})
