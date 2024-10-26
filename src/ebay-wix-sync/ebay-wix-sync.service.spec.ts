import { Test, TestingModule } from '@nestjs/testing';
import { EbayWixSyncService } from './ebay-wix-sync.service';

describe('EbayWixSyncService', () => {
  let service: EbayWixSyncService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [EbayWixSyncService],
    }).compile();

    service = module.get<EbayWixSyncService>(EbayWixSyncService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
