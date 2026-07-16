import axios from "axios";
import * as cheerio from "cheerio";

export interface EtsyProduct {
  title: string;
  price: string;
  currency: string;
  imageUrl: string;
  url: string;
  shopName?: string;
  rating?: string;
}

export async function scrapeEtsyProducts(query: string): Promise<EtsyProduct[]> {
  try {
    const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(query)}`;
    
    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const products: EtsyProduct[] = [];

    // Etsy search listing containers
    $(".v2-listing-card, .wt-grid__item-xs-6").each((_, element) => {
      const $el = $(element);
      
      const title = $el.find(".v2-listing-card__title, h3").text().trim();
      const priceVal = $el.find(".currency-value").first().text().trim();
      const currencySymbol = $el.find(".currency-symbol").first().text().trim() || "$";
      const link = $el.find("a.listing-link, a").attr("href") || "";
      let imageUrl = $el.find("img").attr("src") || $el.find("img").attr("data-src") || "";

      if (imageUrl && imageUrl.startsWith("//")) {
        imageUrl = "https:" + imageUrl;
      }

      if (title && priceVal && link) {
        products.push({
          title,
          price: priceVal,
          currency: currencySymbol,
          imageUrl,
          url: link.startsWith("http") ? link : `https://www.etsy.com${link}`,
          shopName: $el.find(".v2-listing-card__shop, .wt-text-caption").first().text().trim() || undefined
        });
      }
    });

    // Fallback if main selectors failed (Etsy changes design often)
    if (products.length === 0) {
      $("a").each((_, element) => {
        const href = $(element).attr("href") || "";
        if (href.includes("/listing/")) {
          const title = $(element).find("img").attr("alt") || $(element).text().trim();
          const imageUrl = $(element).find("img").attr("src") || "";
          if (title && title.length > 10) {
            products.push({
              title: title.split("\n")[0].trim(),
              price: "N/A",
              currency: "",
              imageUrl,
              url: href.startsWith("http") ? href : `https://www.etsy.com${href}`
            });
          }
        }
      });
    }

    return products.slice(0, 10); // Return top 10 products
  } catch (error) {
    console.error("Error scraping Etsy:", error);
    throw new Error(`Etsy araması başarısız oldu: ${error instanceof Error ? error.message : String(error)}`);
  }
}
