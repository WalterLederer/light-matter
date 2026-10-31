import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { TextComponent, TitleComponent } from '@light-matter/ui';
import { ExifTags } from 'internal-api';
import { ExifService } from '../../../ipc/exif';
import { imageDynamicRange } from '../../../viewer/utils/image-dynamic-range';
import {
  allSortTypes,
  defaultThumbnailSize,
  FileInfo,
  SortType,
  thumbnailDimensions,
  ThumbnailSize
} from 'internal-api';
import { ThumbnailComponent } from '../../../ui/components/thumbnail/thumbnail.component';
import { TimelineIndicatorsComponent } from '../timeline-indicators/timeline-indicators.component';
import { GalleryViewMode, groupImagesByYearAndMonth, YearGroup } from './images.component.types';

@Component({
  selector: 'app-images',
  imports: [
    ThumbnailComponent,
    TitleComponent,
    TimelineIndicatorsComponent,
    TextComponent
  ],
  templateUrl: './images.component.html',
  styleUrl: './images.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.--thumb-width.px]': 'dimensions().width',
    '[style.--thumb-height.px]': 'dimensions().height'
  }
})
export class ImagesComponent {
  private readonly elementRef = inject(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly exif = inject(ExifService);
  private observer: IntersectionObserver | null = null;
  private metadataRequest = 0;
  private readonly metadata = signal<Map<string, ExifTags>>(new Map());

  /* Inputs */
  readonly images = input.required<FileInfo[] | null>();
  readonly sortBy = input<SortType>(allSortTypes[0]);
  readonly thumbSize = input<ThumbnailSize>(defaultThumbnailSize);
  readonly viewMode = input<GalleryViewMode>('thumbnails');
  readonly sortDirection = input<'asc' | 'desc'>('desc');

  private readonly readStoredDetailSortColumn = (): 'name' | 'date' | 'dimensions' | 'size' | 'suffix' | 'hdr' => {
    try {
      const stored = globalThis.localStorage.getItem('light-matter.detailSortColumn');
      return stored === 'name' || stored === 'date' || stored === 'dimensions' || stored === 'size' || stored === 'suffix' || stored === 'hdr' ? stored : 'date';
    } catch { return 'date'; }
  };

  private readonly readStoredDetailSortDirection = (): 'asc' | 'desc' => {
    try {
      const stored = globalThis.localStorage.getItem('light-matter.detailSortDirection');
      return stored === 'asc' || stored === 'desc' ? stored : this.sortDirection();
    } catch { return this.sortDirection(); }
  };

  readonly detailSortColumn = signal<'name' | 'date' | 'dimensions' | 'size' | 'suffix' | 'hdr'>(this.readStoredDetailSortColumn());
  readonly detailSortDirection = signal<'asc' | 'desc'>(this.readStoredDetailSortDirection());

  readonly sortedDetailImages = computed(() => {
    const images = [...(this.images() ?? [])];
    const column = this.detailSortColumn();
    const direction = this.detailSortDirection() === 'asc' ? 1 : -1;
    const metadata = this.metadata();

    const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    const dimensions = (path: string) => {
      const tags = metadata.get(path);
      const width = Number(tags?.ImageWidth) || 0;
      const height = Number(tags?.ImageHeight) || 0;
      return { width, height };
    };
    const hdr = (path: string) => {
      const tags = metadata.get(path) ?? null;
      const bits = tags?.BitsPerSample ?? tags?.BitDepth ?? tags?.ImagePixelDepth ?? null;
      return imageDynamicRange(path, tags, bits === null ? null : String(bits));
    };

    images.sort((a, b) => {
      let result = 0;
      switch (column) {
        case 'name':
          result = compareText(a.name, b.name);
          break;
        case 'date':
          result = (a.modifiedAt ?? a.createdAt) - (b.modifiedAt ?? b.createdAt);
          break;
        case 'size':
          result = a.size - b.size;
          break;
        case 'dimensions': {
          const left = dimensions(a.path);
          const right = dimensions(b.path);
          result = left.width - right.width || left.height - right.height;
          break;
        }
        case 'suffix':
          result = compareText(this.getSuffix(a.name), this.getSuffix(b.name));
          break;
        case 'hdr':
          result = compareText(hdr(a.path), hdr(b.path));
          break;
      }
      return result * direction || compareText(a.name, b.name);
    });
    return images;
  });

  /* Computed */
  readonly dimensions = computed(() => thumbnailDimensions[this.thumbSize()]);
  readonly isDateSorted = computed(() => this.sortBy() === 'date');
  readonly groupedImages = computed<YearGroup[]>(() => {
    if (!this.isDateSorted()) {
      return [];
    }
    return groupImagesByYearAndMonth(this.images());
  });

  /* Signals */
  readonly activeSectionId = signal<string | null>(null);

  /* Outputs */
  readonly selected = output<FileInfo>();

  readonly hovered = output<FileInfo | null>();

  async sortDetailsBy(column: 'name' | 'date' | 'dimensions' | 'size' | 'suffix' | 'hdr'): Promise<void> {
    if (this.detailSortColumn() === column) {
      this.detailSortDirection.update(direction => direction === 'asc' ? 'desc' : 'asc');
    } else {
      this.detailSortColumn.set(column);
      this.detailSortDirection.set(column === 'name' ? 'asc' : 'desc');
    }

    try {
      globalThis.localStorage.setItem('light-matter.detailSortColumn', this.detailSortColumn());
      globalThis.localStorage.setItem('light-matter.detailSortDirection', this.detailSortDirection());
    } catch { /* Keep the selected detail sort for the current session. */ }

    if (column !== 'dimensions' && column !== 'hdr') return;

    const images = this.images() ?? [];
    const request = ++this.metadataRequest;
    const missing = images.filter(image => !this.metadata().has(image.path));
    const results = await Promise.all(missing.map(async image => {
      try {
        const result = await this.exif.read(image.path);
        return result.success ? [image.path, result.data] as const : null;
      } catch {
        return null;
      }
    }));

    if (request !== this.metadataRequest) return;
    this.metadata.update(current => {
      const next = new Map(current);
      for (const result of results) {
        if (result) next.set(result[0], result[1]);
      }
      return next;
    });
  }

  private getSuffix(name: string): string {
    const fileName = name.split(/[\\/]/).pop() ?? name;
    const dotIndex = fileName.lastIndexOf('.');
    return dotIndex > 0 && dotIndex < fileName.length - 1
      ? fileName.slice(dotIndex + 1).toLocaleLowerCase()
      : '';
  }

  sortIndicator(column: 'name' | 'date' | 'dimensions' | 'size' | 'suffix' | 'hdr'): string {
    if (this.detailSortColumn() !== column) return '';
    return this.detailSortDirection() === 'asc' ? ' ▲' : ' ▼';
  }

  constructor() {
    effect(() => {
      const isDate = this.isDateSorted();
      const groups = this.groupedImages();

      if (!isDate || groups.length === 0) {
        this.activeSectionId.set(null);
        this.cleanupObserver();
        return;
      }

      if (!this.activeSectionId() || !groups.some(g => g.months.some(m => m.sectionId === this.activeSectionId()))) {
        this.activeSectionId.set(groups[0]?.months[0]?.sectionId ?? null);
      }

      queueMicrotask(() => {
        this.setupObserver();
      });
    });

    this.destroyRef.onDestroy(() => {
      this.cleanupObserver();
    });
  }

  scrollToSection(sectionId: string): void {
    this.activeSectionId.set(sectionId);
    const element = (this.elementRef.nativeElement as HTMLElement).querySelector(`#${sectionId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  private setupObserver(): void {
    this.cleanupObserver();

    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      return;
    }

    const hostElement = this.elementRef.nativeElement as HTMLElement;
    const root = hostElement.closest('.wrapper');

    this.observer = new IntersectionObserver(
      entries => {
        const visibleEntries = entries.filter(e => e.isIntersecting);
        if (visibleEntries.length > 0) {
          visibleEntries.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          const topVisible = visibleEntries[0];
          const sectionId = topVisible.target.getAttribute('id') ?? topVisible.target.getAttribute('data-section-id');
          if (sectionId) {
            this.activeSectionId.set(sectionId);
          }
        }
      },
      {
        root: root ?? null,
        threshold: [ 0, 0.2, 0.5, 1.0 ],
        rootMargin: '0px 0px -40% 0px'
      }
    );

    const sections = hostElement.querySelectorAll('.month-group');
    sections.forEach(section => {
      this.observer?.observe(section);
    });
  }

  private cleanupObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}
