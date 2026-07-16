import axios from "axios";
import * as cheerio from "cheerio";

export interface AlibabaProduct {
  title: string;
  priceRange: string;
  moq: string; // Minimum Order Quantity
  imageUrl: string;
  url: string;
  supplierName?: string;
}

export async function scrapeAlibabaProducts(query: string): Promise<AlibabaProduct[]> {
  try {
    const searchUrl = `https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(query)}`;
    
    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const products: AlibabaProduct[] = [];

    // Alibaba search listing containers
    $(".card-layout, .search-card-item, .fy-card").each((_, element) => {
      const $el = $(element);
      
      const title = $el.find(".search-card-e-title, .elements-title-normal__out-color, h2").text().trim();
      const priceRange = $el.find(".search-card-e-price-main, .elements-price-normal__price").text().trim();
      const moq = $el.find(".search-card-e-min-order, .element-moq").text().trim();
      const link = $el.find("a").first().attr("href") || "";
      let imageUrl = $el.find("img").attr("src") || $el.find("img").attr("data-src") || "";

      if (imageUrl && imageUrl.startsWith("//")) {
        imageUrl = "https:" + imageUrl;
      }

      if (title && (priceRange || moq)) {
        products.push({
          title,
          priceRange: priceRange || "Fiyat belirtilmemiş",
          moq: moq || "MOQ belirtilmemiş",
          imageUrl,
          url: link.startsWith("http") ? link : `https:${link}`
        });
      }
    });

    // Fallback if main selectors failed
    if (products.length === 0) {
      $("a").each((_, element) => {
        const href = $(element).attr("href") || "";
        if (href.includes("/product-detail/")) {
          const title = $(element).find("img").attr("alt") || $(element).text().trim();
          const imageUrl = $(element).find("img").attr("src") || "";
          if (title && title.length > 10) {
            products.push({
              title: title.split("\n")[0].trim(),
              priceRange: "Bilinmiyor",
              moq: "Bilinmiyor",
              imageUrl,
              url: href.startsWith("http") ? href : `https:${href}`
            });
          }
        }
      });
    }

    return products.slice(0, 10); // Return top 10 products
  } catch (error) {
    console.error("Error scraping Alibaba:", error);
    throw new Error(`Alibaba araması başarısız oldu: ${error instanceof Error ? error.message : String(error)}`);
  }
}
