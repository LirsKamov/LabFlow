import { useState } from "react";
import { TouchableOpacity, Text, View } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";

interface Props {
  date: Date;
  onDateChange: (dateStr: string) => void;
  label?: string;
}

/**
 * 可复用日期选择器：按钮 + 滚轮 DateTimePicker
 *
 * @example
 *   const [expDate, setExpDate] = useState(new Date());
 *   <DatePickerField date={expDate} onDateChange={(s) => setExpDateStr(s)} label="计划日期" />
 */
export default function DatePickerField({ date, onDateChange, label }: Props) {
  const [show, setShow] = useState(false);

  const handleChange = (_event: DateTimePickerEvent, selected?: Date) => {
    setShow(false);
    if (selected) {
      onDateChange(selected.toISOString().split("T")[0]);
    }
  };

  const dateStr = date.toLocaleDateString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  });

  return (
    <View>
      {label && (
        <Text className="text-sm font-semibold text-gray-600 mb-1.5">{label}</Text>
      )}
      <TouchableOpacity
        className="flex-row items-center bg-gray-50 border border-gray-200 rounded-xl px-4 py-3"
        onPress={() => setShow(true)}
        activeOpacity={0.7}
      >
        <Ionicons name="calendar-outline" size={18} color="#6b7280" style={{ marginRight: 8 }} />
        <Text className="text-base text-gray-800 flex-1">{dateStr}</Text>
        <Ionicons name="chevron-down" size={16} color="#d1d5db" />
      </TouchableOpacity>

      {show && (
        <DateTimePicker
          value={date}
          mode="date"
          display="spinner"
          locale="zh-CN"
          onChange={handleChange}
        />
      )}
    </View>
  );
}
