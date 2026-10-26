import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CacheManager } from '../../../ipc/cache-manager';
import { ProcessManager } from '../../../ipc/process-manager';

import { SettingsPanelComponent } from './settings-dialog.component';

describe('SettingsPanelComponent', () => {
  let component: SettingsPanelComponent;
  let fixture: ComponentFixture<SettingsPanelComponent>;

  const cacheManager = {
    cacheInfo: jest.fn().mockResolvedValue({ path: '', entries: 0, bytes: 0, fullSize: { entries: 0, bytes: 0 }, thumbnails: { entries: 0, bytes: 0 } }),
    openCacheFolder: jest.fn().mockResolvedValue(null),
    clear: jest.fn().mockResolvedValue({ entries: 0, bytes: 0 }),
    clearFullSize: jest.fn().mockResolvedValue({ entries: 0, bytes: 0 }),
    clearThumbnails: jest.fn().mockResolvedValue({ entries: 0, bytes: 0 })
  };

  const processManager = {
    getDevToolsOpen: jest.fn().mockResolvedValue(false),
    getSystemPaths: jest.fn().mockResolvedValue({ appConfig: '' }),
    setDevToolsOpen: jest.fn().mockResolvedValue(undefined),
    openConfigFile: jest.fn().mockResolvedValue(null)
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ SettingsPanelComponent ],
      providers: [
        { provide: CacheManager, useValue: cacheManager },
        { provide: ProcessManager, useValue: processManager }
      ]
    })
      .compileComponents();

    fixture = TestBed.createComponent(SettingsPanelComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
