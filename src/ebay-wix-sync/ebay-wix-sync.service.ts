import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import eBayApi from 'ebay-api';
import * as xml2js from 'xml2js';
// make sure to check how to obtain the ebay-oauth-token
import EbayAuthToken from 'ebay-oauth-nodejs-client';

@Injectable()
export class EbayWixSyncService {
  private readonly logger = new Logger(EbayWixSyncService.name);
  private ebayClient: any;
  private ebayAuthToken: any;
  private applicationToken: string;
  private readonly BATCH_SIZE = 10;
  private readonly MAX_PAGES = 1;
  private readonly STORE_NAME =
    this.configService.get<string>('EBAY_STORE_NAME');
  private readonly API_DELAY = 100;
  private lastApiCall: number = 0;

  constructor(private configService: ConfigService) {
    this.initEbayAuth();
    this.initEbayClient();
  }

  private async initEbayAuth() {
    try {
      this.ebayAuthToken = new EbayAuthToken({
        clientId: this.configService.get<string>('EBAY_CLIENT_ID'),
        clientSecret: this.configService.get<string>('EBAY_CLIENT_SECRET'),
        redirectUri: this.configService.get<string>('EBAY_REDIRECT_URI'),
      });

      await this.refreshApplicationToken();

      // Refresh token every 1 hour instead of 2 to ensure we always have a valid token
      setInterval(() => this.refreshApplicationToken(), 3600000);

      this.logger.log('eBay auth initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize eBay auth:', error);
      throw error;
    }
  }

  private async refreshApplicationToken() {
    try {
      const tokenData =
        await this.ebayAuthToken.getApplicationToken('PRODUCTION');
      // Parse the token response
      const tokenResponse = JSON.parse(tokenData);
      this.applicationToken = tokenResponse.access_token;
      this.logger.log('Successfully refreshed eBay application token');
    } catch (error) {
      this.logger.error('Failed to refresh application token:', error);
      throw error;
    }
  }

  private initEbayClient() {
    try {
      this.ebayClient = new eBayApi({
        appId: this.configService.get<string>('EBAY_APP_ID'),
        certId: this.configService.get<string>('EBAY_CERT_ID'),
        sandbox: false,
        authToken: this.configService.get<string>('EBAY_AUTH_TOKEN'),
      });

      this.logger.log('eBay client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize eBay client:', error);
      throw error;
    }
  }

  // Rate limiting helper
  private async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCall;

    if (timeSinceLastCall < this.API_DELAY) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.API_DELAY - timeSinceLastCall),
      );
    }

    this.lastApiCall = Date.now();
  }

  @Cron('* * * * *')
  async syncEbayListingsWithWix() {
    try {
      this.logger.log('Starting eBay-Wix sync');

      const listings = await this.getAllEbayListings();
      this.logger.log(`Retrieved ${listings.length} eBay listings`);

      if (listings.length > 0) {
        for (let i = 0; i < listings.length; i += this.BATCH_SIZE) {
          const batch = listings.slice(i, i + this.BATCH_SIZE);
          const detailedListings = await this.getDetailedListings(batch);
          await this.processListings(detailedListings);
          this.logger.log(`Processed batch ${i / this.BATCH_SIZE + 1}`);

          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } else {
        this.logger.log('No eBay listings found to sync');
      }

      this.logger.log('eBay-Wix sync completed');
    } catch (error) {
      this.logger.error('Error during eBay-Wix sync:', error);
    }
  }

  private async getAllEbayListings(): Promise<any[]> {
    const allItems = [];

    for (let page = 1; page <= this.MAX_PAGES; page++) {
      try {
        await this.enforceRateLimit();

        const searchResults =
          await this.ebayClient.finding.findItemsIneBayStores({
            storeName: this.STORE_NAME,
            paginationInput: {
              entriesPerPage: this.BATCH_SIZE,
              pageNumber: page,
            },
          });

        if (searchResults?.searchResult?.item) {
          const items = searchResults.searchResult.item;
          allItems.push(...items);
          this.logger.log(`Page ${page}: Found ${items.length} items`);

          if (items.length < this.BATCH_SIZE) {
            this.logger.log(`Reached end of items at page ${page}`);
            break;
          }
        } else {
          this.logger.log(`No more items found after page ${page}`);
          break;
        }
      } catch (error) {
        this.logger.error(`Error fetching page ${page}:`, error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
    }

    return allItems;
  }

  private async getDetailedListings(listings: any[]): Promise<any[]> {
    const detailedListings = [];

    for (const listing of listings) {
      try {
        await this.enforceRateLimit();

        this.logger.debug('Processing listing:', listing);

        if (!listing?.itemId) {
          this.logger.warn('Missing itemId in listing:', listing);
          continue;
        }

        // First get high-res images from original listing
        const basicImages = this.extractBasicImages(listing);

        // Then try to get additional details from Shopping API
        const additionalDetails = await this.getShoppingApiDetails(
          listing.itemId,
        );

        const combinedImages = [
          ...basicImages,
          ...(additionalDetails.images || []),
        ].filter((url): url is string => !!url);

        const uniqueImages = [...new Set(combinedImages)].map((url) =>
          this.convertToHighRes(url),
        );

        detailedListings.push({
          ...listing,
          ...additionalDetails,
          images: uniqueImages,
          originalListing: listing,
        });
      } catch (error) {
        this.logger.error(`Error processing listing:`, error);
        // Fallback to basic listing data
        detailedListings.push({
          ...listing,
          images: this.extractBasicImages(listing),
          originalListing: listing,
        });
      }
    }

    return detailedListings;
  }

  private async getShoppingApiDetails(itemId: string): Promise<any> {
    await this.enforceRateLimit();

    const shoppingApiUrl = 'https://open.api.ebay.com/shopping';

    try {
      // Ensure we have a valid token
      if (!this.applicationToken) {
        await this.refreshApplicationToken();
      }

      const headers = {
        'X-EBAY-API-VERSION': '967',
        'X-EBAY-API-SITE-ID': '0', // 0 for US
        'X-EBAY-API-REQUEST-ENCODING': 'XML',
        'X-EBAY-API-CALL-NAME': 'GetSingleItem',
        'X-EBAY-API-IAF-TOKEN': this.applicationToken,
        'X-EBAY-API-APP-ID': this.configService.get<string>('EBAY_APP_ID'),
        'Content-Type': 'text/xml',
        Authorization: `Bearer ${this.applicationToken}`,
      };

      const xmlData = `<?xml version="1.0" encoding="utf-8"?>
        <GetSingleItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
          <ItemID>${itemId}</ItemID>
          <IncludeSelector>Details,Description,ItemSpecifics,Variations,PictureURLs</IncludeSelector>
        </GetSingleItemRequest>`;

      const response = await axios({
        method: 'POST',
        url: shoppingApiUrl,
        headers: headers,
        data: xmlData,
      });

      const result = await this.parseXmlResponse(response.data);

      // Check for error response
      if (result?.GetSingleItemResponse?.Ack === 'Failure') {
        const errors = result.GetSingleItemResponse.Errors;
        if (Array.isArray(errors)) {
          errors.forEach((error) => {
            this.logger.error(
              `eBay API Error: ${error.ShortMessage} - ${error.LongMessage}`,
            );

            // Handle token invalid error
            if (error.ErrorCode === '1.32' || error.ErrorCode === '1.33') {
              this.refreshApplicationToken();
            }
          });
        }
        throw new Error('eBay API request failed');
      }

      if (result?.GetSingleItemResponse?.Item) {
        const item = result.GetSingleItemResponse.Item[0];
        return {
          description: item.Description?.[0],
          images: this.extractAllImages(item),
          details: item,
        };
      }

      return { images: [] };
    } catch (error) {
      this.logger.error('Shopping API error:', error?.response?.data || error);

      // If we get a token error, refresh and retry once
      if (
        error?.response?.data?.includes('Invalid token') ||
        error?.response?.data?.includes('Token not available')
      ) {
        await this.refreshApplicationToken();
        return this.getShoppingApiDetails(itemId); // Retry once with new token
      }

      return { images: [] };
    }
  }

  private extractBasicImages(listing: any): string[] {
    const images = new Set<string>();

    // Add gallery URL
    if (listing.galleryURL) {
      images.add(this.convertToHighRes(listing.galleryURL));
    }

    // Add picture URLs
    if (listing.pictureURL) {
      const urls = Array.isArray(listing.pictureURL)
        ? listing.pictureURL
        : [listing.pictureURL];
      urls.forEach((url) => {
        if (url) images.add(this.convertToHighRes(url));
      });
    }

    return Array.from(images);
  }

  private extractAllImages(item: any): string[] {
    const images = new Set<string>();

    // Extract PictureURL array
    if (item.PictureURL) {
      const urls = Array.isArray(item.PictureURL)
        ? item.PictureURL
        : [item.PictureURL];
      urls.forEach((url) => {
        if (url) images.add(this.convertToHighRes(url));
      });
    }

    // Extract GalleryURL
    if (item.GalleryURL && item.GalleryURL[0]) {
      images.add(this.convertToHighRes(item.GalleryURL[0]));
    }

    // Extract PictureDetails if available
    if (item.PictureDetails) {
      if (item.PictureDetails.GalleryURL) {
        images.add(this.convertToHighRes(item.PictureDetails.GalleryURL[0]));
      }
      if (item.PictureDetails.PictureURL) {
        const pictureUrls = Array.isArray(item.PictureDetails.PictureURL)
          ? item.PictureDetails.PictureURL
          : [item.PictureDetails.PictureURL];
        pictureUrls.forEach((url) => {
          if (url) images.add(this.convertToHighRes(url));
        });
      }
    }

    // Extract from Variations if available
    if (item.Variations && item.Variations.Pictures) {
      item.Variations.Pictures.forEach((picSet) => {
        if (picSet.PictureURL) {
          const urls = Array.isArray(picSet.PictureURL)
            ? picSet.PictureURL
            : [picSet.PictureURL];
          urls.forEach((url) => {
            if (url) images.add(this.convertToHighRes(url));
          });
        }
      });
    }

    return Array.from(images);
  }

  private convertToHighRes(url: string): string {
    if (!url) return url;

    return url
      .replace(/\/thumbs\//, '/')
      .replace(/\/s-l\d+\./, '/s-l1600.')
      .replace(/-thumb\./, '.');
  }

  private async parseXmlResponse(xmlString: string): Promise<any> {
    return new Promise((resolve, reject) => {
      xml2js.parseString(xmlString, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  private async processListings(listings: any[]) {
    let processedCount = 0;

    for (const listing of listings) {
      try {
        await this.enforceRateLimit();

        const wixProduct = await this.convertToWixProduct(listing);

        const createdProduct = await this.createWixProduct(wixProduct);

        if (listing.images?.length > 0) {
          await this.addMediaToWixProduct(
            createdProduct.product.id,
            listing.images,
          );
        }

        processedCount++;
        this.logger.log(
          `Processed ${processedCount}/${listings.length} listings`,
        );
      } catch (error) {
        this.logger.error(`Error processing listing:`, {
          title: listing.Title || listing.originalListing?.title,
          error: error.message,
        });
      }
    }

    this.logger.log(`Successfully processed ${processedCount} listings`);
  }

  private async convertToWixProduct(listing: any) {
    // Clean description - remove eBay-specific HTML and reference numbers

    // Extract item specifics into additional info sections
    const itemSpecifics = this.formatItemSpecifics(
      listing.details?.ItemSpecifics?.[0]?.NameValueList,
    );

    return {
      name: listing.title,
      productType: 'physical',
      priceData: {
        currency: listing.sellingStatus?.currentPrice?.currencyId || 'USD',
        price: parseFloat(
          listing.sellingStatus?.currentPrice?.value ||
            listing.sellingStatus?.convertedCurrentPrice?.value ||
            '0',
        ),
      },
      description:
        listing.description?.length > 8000
          ? listing.description.slice(0, 8000)
          : listing.description,
      sku: Math.random().toString(36).substring(7),
      visible: true,
      weight: 0,
      ribbon: listing.condition?.conditionDisplayName || '',
      inventory: {
        status: 'IN_STOCK',
        quantity: parseInt(listing.details?.Quantity?.[0] || '1', 10),
        trackQuantity: true,
      },
      additionalInfoSections: [
        {
          title: 'Product Details',
          description: itemSpecifics,
        },
        {
          title: 'Return Policy',
          description: this.formatReturnPolicy(
            listing.details?.ReturnPolicy?.[0],
          ),
        },
      ],
      brand: this.extractBrand(listing) || 'Unbranded',
      seoData: {
        tags: [
          {
            type: 'title',
            children: listing.title || '',
          },
          {
            type: 'meta',
            props: {
              name: 'description',
              content: this.createMetaDescription(listing),
            },
          },
        ],
      },
    };
  }

  private extractBrand(listing: any): string {
    return (
      listing.details?.ItemSpecifics?.[0]?.NameValueList?.find(
        (spec: any) => spec.Name?.[0] === 'Brand',
      )?.Value?.[0] || ''
    );
  }

  private createMetaDescription(listing: any): string {
    const condition = listing.condition?.conditionDisplayName || '';
    const brand = this.extractBrand(listing);
    const baseDesc = listing.title || '';

    return `${condition} ${brand} ${baseDesc}`.trim().slice(0, 160);
  }

  // Helper method to clean description
  private cleanDescription(description: string): string {
    if (!description) return '';

    return (
      description
        // Remove eBay reference numbers (typically in format XXX-XXXX)
        .replace(/\b\d{3,}-\d{4,}\b/g, '')
        // Remove HTML comments
        .replace(/<!--[\s\S]*?-->/g, '')
        // Convert <br> tags to newlines
        .replace(/<br\s*\/?>/gi, '\n')
        // Remove any remaining HTML tags
        .replace(/<[^>]+>/g, '')
        // Remove multiple newlines
        .replace(/\n{3,}/g, '\n\n')
        // Trim whitespace
        .trim()
    );
  }

  // Helper method to format item specifics
  private formatItemSpecifics(nameValueList: any[]): string {
    if (!Array.isArray(nameValueList)) return '';

    return nameValueList
      .map((item) => {
        const values = Array.isArray(item.Value)
          ? item.Value.join(', ')
          : item.Value;
        return `**${item.Name}:** ${values}`;
      })
      .join('\n\n');
  }

  // Helper method to format return policy
  private formatReturnPolicy(returnPolicy: any): string {
    if (!returnPolicy) return '';

    const policies = [];
    if (returnPolicy.ReturnsAccepted) {
      policies.push(`Returns: ${returnPolicy.ReturnsAccepted}`);
    }
    if (returnPolicy.ReturnsWithin) {
      policies.push(`Return Window: ${returnPolicy.ReturnsWithin}`);
    }
    if (returnPolicy.ShippingCostPaidBy) {
      policies.push(
        `Return Shipping: Paid by ${returnPolicy.ShippingCostPaidBy}`,
      );
    }
    if (returnPolicy.Refund) {
      policies.push(`Refund Type: ${returnPolicy.Refund}`);
    }

    return policies.join('\n');
  }

  private async createWixProduct(product: any) {
    const wixApiUrl = 'https://www.wixapis.com/stores/v1/products';
    const headers = {
      'Content-Type': 'application/json',
      Authorization: this.configService.get<string>('WIX_AUTH_TOKEN'),
      'wix-site-id': this.configService.get<string>('WIX_SITE_ID'),
    };

    try {
      const response = await axios.post(wixApiUrl, { product }, { headers });
      return response.data;
    } catch (error) {
      this.logger.error(
        'Error creating Wix product:',
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  private async addMediaToWixProduct(productId: string, mediaUrls: string[]) {
    const wixApiUrl = `https://www.wixapis.com/stores/v1/products/${productId}/media`;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: this.configService.get<string>('WIX_AUTH_TOKEN'),
      'wix-site-id': this.configService.get<string>('WIX_SITE_ID'),
    };

    try {
      const mediaItems = mediaUrls.map((url) => ({ url }));
      const response = await axios.post(
        wixApiUrl,
        { media: mediaItems },
        { headers },
      );
      return response.data;
    } catch (error) {
      this.logger.error(
        'Error adding media to Wix product:',
        error.response?.data || error.message,
      );
      throw error;
    }
  }
}
