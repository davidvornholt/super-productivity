import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NoopAnimationsModule } from '@angular/platform-browser/animations';
import { TranslateModule } from '@ngx-translate/core';
import { of } from 'rxjs';
import { TaskService } from '../../../features/tasks/task.service';
import { MagicNavConfigService } from '../../magic-side-nav/magic-nav-config.service';
import { PlayButtonComponent } from './play-button.component';

describe('PlayButtonComponent', () => {
  let taskService: jasmine.SpyObj<TaskService>;
  let navConfigService: jasmine.SpyObj<MagicNavConfigService>;
  let component: PlayButtonComponent;
  let fixture: ComponentFixture<PlayButtonComponent>;

  beforeEach(() => {
    jasmine.clock().install();
    taskService = jasmine.createSpyObj<TaskService>('TaskService', ['toggleStartTask'], {
      currentTask$: of(null),
      currentTaskProgress$: of(0),
    });
    navConfigService = jasmine.createSpyObj<MagicNavConfigService>(
      'MagicNavConfigService',
      ['disableFeature'],
    );

    TestBed.configureTestingModule({
      imports: [PlayButtonComponent, TranslateModule.forRoot(), NoopAnimationsModule],
      providers: [
        { provide: TaskService, useValue: taskService },
        { provide: MagicNavConfigService, useValue: navConfigService },
      ],
    });
    fixture = TestBed.createComponent(PlayButtonComponent);
    fixture.detectChanges();
    component = fixture.componentInstance;
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  it('toggles tracking on a normal click', () => {
    component.onPlayPointerDown();
    component.onPlayClick();
    expect(taskService.toggleStartTask).toHaveBeenCalledTimes(1);
  });

  it('ignores the click that ends a long press', () => {
    component.onPlayPointerDown();
    component.onLongPress();
    component.onPlayClick();
    expect(taskService.toggleStartTask).not.toHaveBeenCalled();
  });

  it('does not swallow the next tap when the long press ended without a click', () => {
    // e.g. the menu backdrop took the release, then the menu was closed
    component.onPlayPointerDown();
    component.onLongPress();

    component.onPlayPointerDown();
    component.onPlayClick();
    expect(taskService.toggleStartTask).toHaveBeenCalledTimes(1);
  });

  it('disables time tracking like the side nav disables its features', () => {
    component.disableTimeTracking();
    expect(navConfigService.disableFeature).toHaveBeenCalledOnceWith(
      'isTimeTrackingEnabled',
      jasmine.any(String),
    );
  });

  describe('tracking pulse', () => {
    const track = (taskId: string | null): void => {
      fixture.componentRef.setInput('currentTaskId', taskId);
      fixture.detectChanges();
    };
    const endPulse = (): void => {
      fixture.nativeElement
        .querySelector('.pulse-circle')
        .dispatchEvent(new Event('animationend'));
    };

    it('pulses when tracking starts', () => {
      track('task-1');
      expect(component.isPulsing()).toBeTrue();
    });

    it('pulses again only after a pause instead of looping', () => {
      track('task-1');
      endPulse();
      expect(component.isPulsing()).toBeFalse();

      jasmine.clock().tick(29_999);
      expect(component.isPulsing()).toBeFalse();
      jasmine.clock().tick(1);
      expect(component.isPulsing()).toBeTrue();
    });

    it('stops pulsing when tracking stops', () => {
      track('task-1');
      track(null);
      expect(component.isPulsing()).toBeFalse();

      jasmine.clock().tick(60_000);
      expect(component.isPulsing()).toBeFalse();
    });
  });
});
