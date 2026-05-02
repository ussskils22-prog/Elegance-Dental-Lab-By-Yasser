import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'sizeFormat',
  standalone: true,
})
export class SizeFormatPipe implements PipeTransform {
  transform(value: string | number): string {
    if (!value) return '--';
    const strValue = String(value).trim();
    if (strValue.endsWith('mm')) {
      return strValue;
    }
    return `${strValue}mm`;
  }
}
