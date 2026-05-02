import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'patientLabel',
  standalone: true,
})
export class PatientLabelPipe implements PipeTransform {
  transform(value: string): string {
    if (!value) return 'المريض: --';
    if (value.startsWith('المريض:')) {
      return value;
    }
    return `المريض: ${value}`;
  }
}
