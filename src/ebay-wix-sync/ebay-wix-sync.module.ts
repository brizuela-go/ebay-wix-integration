import { Module } from '@nestjs/common';
import { EbayWixSyncService } from './ebay-wix-sync.service';

@Module({
  providers: [EbayWixSyncService],
})
export class EbayWixSyncModule {}
